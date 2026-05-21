import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
// import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

// defines the inputs this stack requires from NetworkStack.
// extends cdk.StackProps so standard props like env are still accepted.
interface ApplicationStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  albSg: ec2.ISecurityGroup;
  ecsSg: ec2.ISecurityGroup;
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
      vpcSubnets: { subnets: [props.vpc.privateSubnets[0]] },
      // second EBS volume for VM Storage data. deleteOnTermination: false so the
      // volume outlives instance replacement — data survives a redeploy.
      blockDevices: [{
        deviceName: '/dev/xvdb',
        volume: autoscaling.BlockDeviceVolume.ebs(50, {
          volumeType: autoscaling.EbsDeviceVolumeType.GP3,
          deleteOnTermination: false,
        }),
      }],
    });
    asg.addSecurityGroup(props.ecsSg);

    // resolve the CloudFormation logical ID of the ASG at synth time.
    // this is needed so the cfn-signal command on the instance knows which
    // CloudFormation resource to signal when it is ready.
    const cfnAsg = asg.node.defaultChild as autoscaling.CfnAutoScalingGroup;
    const asgLogicalId = this.getLogicalId(cfnAsg);

    // set the CreationPolicy directly on the CloudFormation resource rather than
    // via the CDK 'signals' property — addCapacity() sets updateType internally
    // which conflicts with 'signals'. both approaches produce the same CloudFormation
    // output: CloudFormation waits for a signal from the instance before proceeding.
    cfnAsg.cfnOptions.creationPolicy = {
      resourceSignal: {
        count: 1,
        timeout: 'PT10M',
      },
    };

    // format the volume on first boot (blkid exits non-zero if unformatted), then mount it.
    // nofail in fstab prevents the instance hanging on boot if the volume is briefly unavailable.
    asg.userData.addCommands(
      'blkid /dev/xvdb || mkfs -t xfs /dev/xvdb',
      'mkdir -p /data/vm-storage',
      'mount /dev/xvdb /data/vm-storage || true',
      "echo '/dev/xvdb /data/vm-storage xfs defaults,nofail 0 2' >> /etc/fstab",
      // poll the ECS agent's local metadata endpoint every 2 seconds until ClusterARN appears.
      // ClusterARN being present means the agent has successfully registered with the ECS cluster.
      'until curl -s http://localhost:51678/v1/metadata | grep -q ClusterARN; do sleep 2; done',
      // send a success signal to CloudFormation. this is what unblocks the deployment —
      // CloudFormation will not create the ECS services until this signal is received.
      `/opt/aws/bin/cfn-signal -e 0 --stack ${this.stackName} --resource ${asgLogicalId} --region ${this.region}`,
    );

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
    //EDIT: This is commented out for now because it appears it might not be 
    // needed as an IAM role with the same permissions is auto added. 
    // const ec2InstanceRole = new iam.Role(this, 'Ec2InstanceRole', {
    //   assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    //   managedPolicies: [
    //     iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
    //   ],
    // });

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
      networkMode: ecs.NetworkMode.HOST,
    });
    vmAgentTaskDef.addContainer('VmAgentContainer', {
      image: ecs.ContainerImage.fromRegistry('victoriametrics/vmagent:latest'),
      memoryLimitMiB: 512,
      portMappings: [{ containerPort: 8429 }],
      command: ['-remoteWrite.url=http://localhost:8480/insert/0/prometheus'],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'vm-agent',
        logGroup: new logs.LogGroup(this, 'VmAgentLogGroup', {
          logGroupName: '/metropolis/vm-agent',
          removalPolicy: cdk.RemovalPolicy.RETAIN,
        }),
      }),
    });

    const vmInsertTaskDef = new ecs.Ec2TaskDefinition(this, 'VmInsertTaskDef', {
      executionRole: taskExecutionRole,
      networkMode: ecs.NetworkMode.HOST,
    });
    vmInsertTaskDef.addContainer('VmInsertContainer', {
      image: ecs.ContainerImage.fromRegistry('victoriametrics/vminsert:latest'),
      memoryLimitMiB: 512,
      portMappings: [{ containerPort: 8480 }],
      command: ['-storageNode=localhost:8400'],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'vm-insert',
        logGroup: new logs.LogGroup(this, 'VmInsertLogGroup', {
          logGroupName: '/metropolis/vm-insert',
          removalPolicy: cdk.RemovalPolicy.RETAIN,
        }),
      }),
    });

    const vmSelectTaskDef = new ecs.Ec2TaskDefinition(this, 'VmSelectTaskDef', {
      executionRole: taskExecutionRole,
      networkMode: ecs.NetworkMode.HOST,
    });
    vmSelectTaskDef.addContainer('VmSelectContainer', {
      image: ecs.ContainerImage.fromRegistry('victoriametrics/vmselect:latest'),
      memoryLimitMiB: 512,
      portMappings: [{ containerPort: 8481 }],
      command: ['-storageNode=localhost:8401'],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'vm-select',
        logGroup: new logs.LogGroup(this, 'VmSelectLogGroup', {
          logGroupName: '/metropolis/vm-select',
          removalPolicy: cdk.RemovalPolicy.RETAIN,
        }),
      }),
    });

    // VM Storage needs a volume mount for the EBS volume — handled in the EBS section below.
    // the container reference is stored so we can call addMountPoints() on it later.
    const vmStorageTaskDef = new ecs.Ec2TaskDefinition(this, 'VmStorageTaskDef', {
      executionRole: taskExecutionRole,
      networkMode: ecs.NetworkMode.HOST,
    });
    const vmStorageContainer = vmStorageTaskDef.addContainer('VmStorageContainer', {
      image: ecs.ContainerImage.fromRegistry('victoriametrics/vmstorage:latest'),
      memoryLimitMiB: 1024,
      portMappings: [{ containerPort: 8482 }],
      command: ['-storageDataPath=/victoria-metrics-data'],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'vm-storage',
        logGroup: new logs.LogGroup(this, 'VmStorageLogGroup', {
          logGroupName: '/metropolis/vm-storage',
          removalPolicy: cdk.RemovalPolicy.RETAIN,
        }),
      }),
    });

    const grafanaTaskDef = new ecs.Ec2TaskDefinition(this, 'GrafanaTaskDef', {
      executionRole: taskExecutionRole,
      networkMode: ecs.NetworkMode.HOST,
    });
    grafanaTaskDef.addContainer('GrafanaContainer', {
      image: ecs.ContainerImage.fromRegistry('grafana/grafana:latest'),
      memoryLimitMiB: 512,
      portMappings: [{ containerPort: 3000 }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'grafana',
        logGroup: new logs.LogGroup(this, 'GrafanaLogGroup', {
          logGroupName: '/metropolis/grafana',
          removalPolicy: cdk.RemovalPolicy.RETAIN,
        }),
      }),
    });

    // ── ECS Services ──────────────────────────────────────────────────────────
    // one per container, each linked to the cluster and task definition.
    // node.addDependency(asg) on every service forces CloudFormation to wait for
    // the ASG CreationPolicy signal before creating any service. without this,
    // CloudFormation creates services and the ASG in parallel — tasks fail to
    // place because the ECS agent hasn't registered yet.
    const vmAgentService = new ecs.Ec2Service(this, 'VmAgentService', {
      cluster: cluster,
      taskDefinition: vmAgentTaskDef,
      desiredCount: 1,
      minHealthyPercent: 0,
      circuitBreaker: { rollback: true },
    });
    vmAgentService.node.addDependency(asg);

    const vmInsertService = new ecs.Ec2Service(this, 'VmInsertService', {
      cluster: cluster,
      taskDefinition: vmInsertTaskDef,
      desiredCount: 1,
      minHealthyPercent: 0,
    });
    vmInsertService.node.addDependency(asg);

    const vmSelectService = new ecs.Ec2Service(this, 'VmSelectService', {
      cluster: cluster,
      taskDefinition: vmSelectTaskDef,
      desiredCount: 1,
      minHealthyPercent: 0,
    });
    vmSelectService.node.addDependency(asg);

    const vmStorageService = new ecs.Ec2Service(this, 'VmStorageService', {
      cluster: cluster,
      taskDefinition: vmStorageTaskDef,
      desiredCount: 1,
      // mhp: 100 + mhp: 0 ensures ECS stops the old task before starting the new one —
      // prevents two storage tasks writing to the same EBS volume simultaneously.
      maxHealthyPercent: 100,
      minHealthyPercent: 0,
    });
    vmStorageService.node.addDependency(asg);

    const grafanaService = new ecs.Ec2Service(this, 'GrafanaService', {
      cluster: cluster,
      taskDefinition: grafanaTaskDef,
      desiredCount: 1,
      minHealthyPercent: 0,
      circuitBreaker: { rollback: true },
    });
    grafanaService.node.addDependency(asg);

    // ── Application Load Balancer ─────────────────────────────────────────────
    // sits in the public subnet, listeners on port 8429 (telemetry) and 3000 (Grafana)
    const alb = new elbv2.ApplicationLoadBalancer(this, 'MetropolisALB', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // both these listeners will need HTTPS protocol in production. 
    // open: false — albSg already defines inbound rules, prevents CDK adding a duplicate 0.0.0.0/0 ingress.
    const telemetryListener = alb.addListener('TelemetryListener', {
      port: 8429,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
    });
    telemetryListener.addTargets('VmAgentTarget', {
      port: 8429,
      protocol: elbv2.ApplicationProtocol.HTTP,
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
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
    });
    grafanaListener.addTargets('GrafanaTarget', {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
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
    const metricsReader = new lambda.Function(this, 'MetricsReaderFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      // placeholder — real implementation reads from VM/Grafana and writes to RDS
      code: lambda.Code.fromInline('exports.handler = async () => {};'),
      role: lambdaExecutionRole,
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      timeout: cdk.Duration.minutes(5),
    });

    const metricsSchedule = new events.Rule(this, 'MetricsReaderSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(24)),
    });
    metricsSchedule.addTarget(new targets.LambdaFunction(metricsReader));

    // ── EBS Volume ────────────────────────────────────────────────────────────
    // attached to the EC2 instance, mounted by VM Storage for persistent data
    // host volume bridges the EC2 mount path to the task definition.
    vmStorageTaskDef.addVolume({
      name: 'vm-storage-data',
      host: { sourcePath: '/data/vm-storage' },
    });

    // maps the host volume into the container at VictoriaMetrics' default data path.
    vmStorageContainer.addMountPoints({
      containerPath: '/victoria-metrics-data',
      sourceVolume: 'vm-storage-data',
      readOnly: false,
    });
  }
}
