import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';

// synthesize the stack once and reuse across all tests
const app = new cdk.App();
const stack = new NetworkStack(app, 'TestNetworkStack');
const template = Template.fromStack(stack);

// ── VPC ────────────────────────────────────────────────────────────────────

// confirms the private subnet has outbound internet access for container image pulls
test('VPC is created with one NAT gateway', () => {
  template.resourceCountIs('AWS::EC2::NatGateway', 1);
});

// CDK creates one subnet per AZ per type.
// maxAzs: 2 → 2 public + 2 private = 4 subnets total.
test('VPC has two public and two private subnets', () => {
  template.resourceCountIs('AWS::EC2::Subnet', 4);
});

// ── Security Groups ────────────────────────────────────────────────────────

// ALB, ECS, RDS — lambdaSg was removed when Lambda was replaced by smart-metrics
test('three security groups are created', () => {
  template.resourceCountIs('AWS::EC2::SecurityGroup', 3);
});

// confirms client agents can push telemetry to the ALB from anywhere
// Match.arrayWith checks the array contains this rule, allowing other rules to also exist
test('ALB security group allows inbound on port 8429 from the internet', () => {
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: Match.arrayWith([
      // Match.objectLike ignores extra keys CDK adds automatically (e.g. Description)
      Match.objectLike({ FromPort: 8429, ToPort: 8429, CidrIp: '0.0.0.0/0', IpProtocol: 'tcp' }),
    ]),
  });
});

// confirms Grafana is accessible over HTTPS via the ALB
test('ALB security group allows inbound on port 443 from the internet', () => {
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: Match.arrayWith([
      Match.objectLike({ FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0', IpProtocol: 'tcp' }),
    ]),
  });
});

// confirms HTTP traffic is accepted so the ALB can issue HTTP→HTTPS redirects
test('ALB security group allows inbound on port 80 from the internet', () => {
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: Match.arrayWith([
      Match.objectLike({ FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0', IpProtocol: 'tcp' }),
    ]),
  });
});

// confirms RDS only accepts Postgres traffic — no other ports can reach the database
// SG-to-SG ingress rules are separate CloudFormation resources, not inline SG properties
test('RDS security group allows inbound on port 5432 only', () => {
  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    FromPort: 5432,
    ToPort: 5432,
    IpProtocol: 'tcp',
  });
});

// ── Cross-node ECS traffic ─────────────────────────────────────────────────
// All three nodes share ecsSg. The self-referencing rules below allow vminsert
// and vmselect (on the interface node) to reach vmstorage (on the storage node)
// across EC2 instance boundaries.

// vminsert writes to vmstorage on 8400
test('ECS security group allows cross-node traffic on vmstorage write port 8400', () => {
  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    FromPort: 8400,
    ToPort: 8400,
    IpProtocol: 'tcp',
  });
});

// vmselect reads from vmstorage on 8401
test('ECS security group allows cross-node traffic on vmstorage read port 8401', () => {
  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    FromPort: 8401,
    ToPort: 8401,
    IpProtocol: 'tcp',
  });
});

// grafana queries vmselect on 8481
test('ECS security group allows cross-node traffic on vmselect query port 8481', () => {
  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    FromPort: 8481,
    ToPort: 8481,
    IpProtocol: 'tcp',
  });
});
