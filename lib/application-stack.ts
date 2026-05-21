import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

// defines the inputs this stack requires from NetworkStack.
// extends cdk.StackProps so standard props like env are still accepted.
interface ApplicationStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  albSg: ec2.ISecurityGroup;
  ecsSg: ec2.ISecurityGroup;
  rdsSg: ec2.ISecurityGroup;
  lambdaSg: ec2.ISecurityGroup;
}

export class ApplicationStack extends cdk.Stack {
  // props is no longer optional — the VPC and security groups are required to deploy this stack.
  constructor(scope: Construct, id: string, props: ApplicationStackProps) {
    super(scope, id, props);

    // ── ECR ───────────────────────────────────────────────────────────────────
    // repositories to store images for pulldown on new container creation. They are pushed to the their
    // respective ECR repo on every new deploy of ECS. 
    // we do not need this until we have custom images, which we do not yet. 
    // const vmAgentRepo = new ecr.Repository(this, 'VmAgentRepository');
    // const vmInsertRepo = new ecr.Repository(this, 'VmInsertRepository');
    // const vmSelectRepo = new ecr.Repository(this, 'VmSelectRepository');
    // const vmStorageRepo = new ecr.Repository(this, 'VmStorageRepository');
    // const grafanaRepo = new ecr.Repository(this, 'GrafanaRepository');

    // ── ECS Cluster ───────────────────────────────────────────────────────────
    // logical grouping for all ECS tasks and services. Tied to the VPC from NetworkStack.
    const cluster = new ecs.Cluster(this, 'MetropolisCluster', {
      vpc: props.vpc,
    });

    // ── EC2 Auto Scaling Group ────────────────────────────────────────────────
    // provides the actual EC2 instances the ECS cluster runs containers on.
    // instances are placed in the private subnet and use the ECS security group defined in NetworkStack.
    // addCapacity returns the ASG so we can attach the security group from NetworkStack to it
    const asg = cluster.addCapacity('MetropolisASG', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      desiredCapacity: 1,
      maxCapacity: 3,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    asg.addSecurityGroup(props.ecsSg);

    // ── IAM Roles ─────────────────────────────────────────────────────────────

    // role to ensure ECS can write output logs to cloudwatch and pull container Images from ECS
    const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      // assumedBy tells AWS that ECS (not a user) is the one using this role.
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    //role for ASG to register EC2 instances with ECS cluster
    const ec2InstanceRole = new iam.Role(this, 'Ec2InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
      ],
    });

    // role for Lambda functions to write logs to cloudwatch and to interact with other services in the VPC
    const lambdaExecutionRole = new iam.Role(this, 'LambdaExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')
      ]
    })

    // ── ECS Task Definitions ──────────────────────────────────────────────────
    // Ec2TaskDefinition is used because we are running on EC2 instances, not Fargate.
    // executionRole grants ECS permission to write logs to CloudWatch for each task.
    // addContainer attaches the container spec — image, memory, port, and log destination.

    const vmAgentTaskDef = new ecs.Ec2TaskDefinition(this, 'VmAgentTaskDef', {
      executionRole: taskExecutionRole,
    });
    vmAgentTaskDef.addContainer('VmAgentContainer', {
      image: ecs.ContainerImage.fromRegistry('victoriametrics/vmagent:latest'),
      memoryLimitMiB: 512,
      portMappings: [{ containerPort: 8429 }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'vm-agent',
        logGroup: new logs.LogGroup(this, 'VmAgentLogGroup', {
          logGroupName: '/metropolis/vm-agent',
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
    });

    const vmInsertTaskDef = new ecs.Ec2TaskDefinition(this, 'VmInsertTaskDef', {
      executionRole: taskExecutionRole,
    });
    vmInsertTaskDef.addContainer('VmInsertContainer', {
      image: ecs.ContainerImage.fromRegistry('victoriametrics/vminsert:latest'),
      memoryLimitMiB: 512,
      portMappings: [{ containerPort: 8480 }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'vm-insert',
        logGroup: new logs.LogGroup(this, 'VmInsertLogGroup', {
          logGroupName: '/metropolis/vm-insert',
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
    });

    const vmSelectTaskDef = new ecs.Ec2TaskDefinition(this, 'VmSelectTaskDef', {
      executionRole: taskExecutionRole,
    });
    vmSelectTaskDef.addContainer('VmSelectContainer', {
      image: ecs.ContainerImage.fromRegistry('victoriametrics/vmselect:latest'),
      memoryLimitMiB: 512,
      portMappings: [{ containerPort: 8481 }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'vm-select',
        logGroup: new logs.LogGroup(this, 'VmSelectLogGroup', {
          logGroupName: '/metropolis/vm-select',
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
    });

    // VM Storage needs a volume mount for the EBS volume — handled in the EBS section below.
    // the container reference is stored so we can call addMountPoints() on it later.
    const vmStorageTaskDef = new ecs.Ec2TaskDefinition(this, 'VmStorageTaskDef', {
      executionRole: taskExecutionRole,
    });
    const vmStorageContainer = vmStorageTaskDef.addContainer('VmStorageContainer', {
      image: ecs.ContainerImage.fromRegistry('victoriametrics/victoria-metrics:latest'),
      memoryLimitMiB: 1024,
      portMappings: [{ containerPort: 8482 }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'vm-storage',
        logGroup: new logs.LogGroup(this, 'VmStorageLogGroup', {
          logGroupName: '/metropolis/vm-storage',
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
    });

    const grafanaTaskDef = new ecs.Ec2TaskDefinition(this, 'GrafanaTaskDef', {
      executionRole: taskExecutionRole,
    });
    grafanaTaskDef.addContainer('GrafanaContainer', {
      image: ecs.ContainerImage.fromRegistry('grafana/grafana:latest'),
      memoryLimitMiB: 512,
      portMappings: [{ containerPort: 3000 }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'grafana',
        logGroup: new logs.LogGroup(this, 'GrafanaLogGroup', {
          logGroupName: '/metropolis/grafana',
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
    });

    // ── ECS Services ──────────────────────────────────────────────────────────
    // one per container, each linked to the cluster and task definition
    const vmAgentService = new ecs.Ec2Service(this, 'VmAgentService', {
      cluster: cluster,
      taskDefinition: vmAgentTaskDef,
      desiredCount: 1,
    });
    
    // won't be used again so no need to store
    new ecs.Ec2Service(this, 'VmInsertService', {
      cluster: cluster,
      taskDefinition: vmInsertTaskDef,
      desiredCount: 1,
    });

    // same as above
    new ecs.Ec2Service(this, 'VmSelectService', {
      cluster: cluster,
      taskDefinition: vmSelectTaskDef,
      desiredCount: 1,
    });
    
    //again same
    new ecs.Ec2Service(this, 'VmStorageService', {
      cluster: cluster,
      taskDefinition: vmStorageTaskDef,
      desiredCount: 1,
      // mhp is to ensure that two storage tasks can never be concurrently running.
      maxHealthyPercent: 100,
      minHealthyPercent: 0
    })

    const grafanaService = new ecs.Ec2Service(this, 'GrafanaService', {
      cluster: cluster,
      taskDefinition: grafanaTaskDef,
      desiredCount: 1,
    });

    // ── Application Load Balancer ─────────────────────────────────────────────
    // sits in the public subnet, listeners on port 8429 (telemetry) and 3000 (Grafana)
    const alb = new elbv2.ApplicationLoadBalancer(this, 'MetropolisALB', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // open: false — albSg already defines inbound rules, prevents CDK adding a duplicate 0.0.0.0/0 ingress.
    const telemetryListener = alb.addListener('TelemetryListener', {
      port: 8429,
      open: false,
    });
    telemetryListener.addTargets('VmAgentTarget', {
      port: 8429,
      targets: [vmAgentService.loadBalancerTarget({
        containerName: 'VmAgentContainer',
        containerPort: 8429,
      })],
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(30),
      },
    });

    const grafanaListener = alb.addListener('GrafanaListener', {
      port: 3000,
      open: false,
    });
    grafanaListener.addTargets('GrafanaTarget', {
      port: 3000,
      targets: [grafanaService.loadBalancerTarget({
        containerName: 'GrafanaContainer',
        containerPort: 3000,
      })],
      healthCheck: {
        path: '/api/health',
        interval: cdk.Duration.seconds(30),
      },
    });

    // ── Lambda + EventBridge ──────────────────────────────────────────────────
    // Lambda reads from VM and Grafana endpoints every 24hrs and writes to RDS
    // EventBridge triggers the Lambda on a cron schedule

    // ── EBS Volume ────────────────────────────────────────────────────────────
    // attached to the EC2 instance, mounted by VM Storage for persistent data
  }
}
