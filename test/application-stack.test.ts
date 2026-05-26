import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { ApplicationStack } from '../lib/application-stack';

// synthesize all three stacks — ApplicationStack requires the S3 bucket from DataStack
const app = new cdk.App();
const network = new NetworkStack(app, 'TestNetworkStack');
const data = new DataStack(app, 'TestDataStack', {
  vpc: network.vpc,
  rdsSg: network.rdsSg,
});
const stack = new ApplicationStack(app, 'TestApplicationStack', {
  vpc: network.vpc,
  albSg: network.albSg,
  ecsSg: network.ecsSg,
  metricsBucket: data.metricsBucket,
});
const template = Template.fromStack(stack);

// ── ECS Cluster ────────────────────────────────────────────────────────────

test('ECS cluster is created', () => {
  template.resourceCountIs('AWS::ECS::Cluster', 1);
});

// ── Auto Scaling Groups ────────────────────────────────────────────────────
// Three nodes: interface (t3.medium), select (t3.small), storage (t3.medium).
// All have maxCapacity: 1 — vertical scaling only, no horizontal expansion.

test('three ASGs are created, one per node', () => {
  template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 3);
});

test('all ASGs have a max size of 1', () => {
  template.allResourcesProperties('AWS::AutoScaling::AutoScalingGroup', {
    MaxSize: '1',
  });
});

// ── Task Definitions ───────────────────────────────────────────────────────
// vmagent, vminsert, vmselect, vmstorage, grafana, vector, smart-metrics = 7

test('seven task definitions are created', () => {
  template.resourceCountIs('AWS::ECS::TaskDefinition', 7);
});

// vmstorage mounts the EBS volume from the storage node's host filesystem
test('vmstorage task definition has a volume mount for EBS data', () => {
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Volumes: Match.arrayWith([
      Match.objectLike({ Host: { SourcePath: '/data/vm-storage' } }),
    ]),
  });
});

// vmagent and smart-metrics share /shared/vmagent so smart-metrics can write
// aggregations.yaml and vmagent can reload it without network calls
test('vmagent task definition shares the /shared/vmagent host volume', () => {
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Volumes: Match.arrayWith([
      Match.objectLike({ Host: { SourcePath: '/shared/vmagent' } }),
    ]),
  });
});

// ── ECS Services ───────────────────────────────────────────────────────────
// vmagent, vminsert, vmselect, vmstorage, grafana, vector = 6 long-running services.
// smart-metrics is EventBridge-triggered (not a persistent ECS Service resource).

test('six ECS services are created', () => {
  template.resourceCountIs('AWS::ECS::Service', 6);
});

// all six services should have circuit breakers configured
test('all services have deployment circuit breakers enabled', () => {
  template.allResourcesProperties('AWS::ECS::Service', {
    DeploymentConfiguration: Match.objectLike({
      DeploymentCircuitBreaker: Match.objectLike({ Enable: true, Rollback: true }),
    }),
  });
});

// ── Cloud Map ──────────────────────────────────────────────────────────────
// vmselect and vmstorage register DNS names in trickl.local so inter-node
// communication works without hardcoded IPs.

test('Cloud Map private DNS namespace trickl.local is created', () => {
  template.hasResourceProperties('AWS::ServiceDiscovery::PrivateDnsNamespace', {
    Name: 'trickl.local',
  });
});

// ── Application Load Balancer ──────────────────────────────────────────────

test('ALB is created and is internet-facing', () => {
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Scheme: 'internet-facing',
  });
});

// one for vmagent (8429) and one for grafana (3000)
test('two listeners are created', () => {
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 2);
});

test('telemetry listener is on port 8429', () => {
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
    Port: 8429,
    Protocol: 'HTTP',
  });
});

test('grafana listener is on port 3000', () => {
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
    Port: 3000,
    Protocol: 'HTTP',
  });
});

// ── Smart Metrics + EventBridge ───────────────────────────────────────────
// Lambda was removed. smart-metrics runs as an ECS task on a 24h EventBridge
// schedule instead, sharing the interface node's /shared/vmagent host volume.

// CDK normalises Duration.hours(24) to "rate(1 day)" in CloudFormation
test('EventBridge rule triggers smart-metrics on a 24-hour schedule', () => {
  template.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'rate(1 day)',
  });
});

// ── Log Groups ─────────────────────────────────────────────────────────────
// vmagent, vminsert, vmselect, vmstorage, grafana, vector, smart-metrics = 7

test('seven log groups are created', () => {
  template.resourceCountIs('AWS::Logs::LogGroup', 7);
});
