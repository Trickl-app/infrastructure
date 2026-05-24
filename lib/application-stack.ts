import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
// import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as serviceDiscover from 'aws-cdk-lib/aws-servicediscovery';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

// ------- COMPONENTS AND DESCRIPTIONS --------- //

// ECS Cluster:empty logical grouping tied to the VPC that containers will eventually run in.
// Auto Scaling Group - the pool of EC2 instances the cluster runs containers on, with the second EBS volume attached.
// User Data:boot commands that format and mount the EBS volume on the EC2 instance.
// IAM Roles:permissions that allow ECS to pull images and write logs, and Lambda to run inside the VPC.
// Task Definitions:blueprints describing how each container should be configured and run.
// ECS Services:managers that keep a specified number of task instances running at all times, restarting on failure.
// Application Load Balancer:public-facing entry point that receives traffic and forwards it to the correct container.
// Lambda + EventBridge:scheduled function that reads from VictoriaMetrics and Grafana and writes results to RDS.
// EBS Volume:persistent disk mounted into the VM Storage container to survive instance replacement.

// defines the inputs this stack requires from NetworkStack.
// extends cdk.StackProps so standard props like env are still accepted.
interface ApplicationStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  albSg: ec2.ISecurityGroup;
  ecsSg: ec2.ISecurityGroup;
  metricsBucket: s3.IBucket;
}

export class ApplicationStack extends cdk.Stack {
  // props is no longer optional:the VPC and security groups are required to deploy this stack.
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
    // Just the shell. Will need to run .addCapacity to acutally add compute. 
    const cluster = new ecs.Cluster(this, 'MetropolisCluster', {
      vpc: props.vpc,
    });

    // ── EC2 Auto Scaling Group ────────────────────────────────────────────────
    // provides the actual EC2 instances. Made assumptions about the size we would need. 
    // instances are placed in the private subnet and use the ECS security group defined in NetworkStack.
  
    const interfaceASG = cluster.addCapacity("InterfaceASG", {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      desiredCapacity:1,
      maxCapacity: 1,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }
    });
    interfaceASG.addSecurityGroup(props.ecsSg);

    const selectASG = cluster.addCapacity("vmselectASG", {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      desiredCapacity: 1,
      maxCapacity: 1,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }
    });
    selectASG.addSecurityGroup(props.ecsSg);

    const storageASG = cluster.addCapacity("vmstorageASG", {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      desiredCapacity: 1,
      maxCapacity: 1,
      vpcSubnets: { subnets: [props.vpc.privateSubnets[0]] },
      blockDevices: [{
        deviceName: '/dev/xvdb',
        volume: autoscaling.BlockDeviceVolume.ebs(50, {
          volumeType: autoscaling.EbsDeviceVolumeType.GP3,
          deleteOnTermination: false,
        }),
      }],
    })
    storageASG.addSecurityGroup(props.ecsSg);

    // config for the EBS volume. My understanding is weak here, but they are all essential. 
    storageASG.userData.addCommands(
      // formats the disk with a file system. 
      'blkid /dev/xvdb || mkfs -t xfs /dev/xvdb',
      // cretes the folder the disk will be accessible through.
      'mkdir -p /data/vm-storage',
      // attached the disk to that folde.r 
      'mount /dev/xvdb /data/vm-storage || true',
      // tells the os to repeat on every reboot. 
      "echo '/dev/xvdb /data/vm-storage xfs defaults,nofail 0 2' >> /etc/fstab",
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
    // Instructions for ECS on how to run the containers. Just a spec
    // executionRole grants ECS permission to write logs to CloudWatch for each task.
    // addContainer attaches the container spec:image, memory, port, and log destination.

    const vmAgentTaskDef = new ecs.Ec2TaskDefinition(this, 'VmAgentTaskDef', {
      executionRole: taskExecutionRole,
      networkMode: ecs.NetworkMode.HOST,
    });
    vmAgentTaskDef.addContainer('VmAgentContainer', {
      // docker image to pull
      image: ecs.ContainerImage.fromRegistry('victoriametrics/vmagent:latest'),
      // default assumption
      memoryLimitMiB: 512,
      portMappings: [{ containerPort: 8429 }],
      command: ['-remoteWrite.url=http://localhost:8480/insert/0/prometheus'],
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
          removalPolicy: cdk.RemovalPolicy.DESTROY,
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
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
    });

    // VM Storage needs a volume mount for the EBS volume:handled in the EBS section below.
    // the container reference is stored so we can call addMountPoints() on it later.
    const vmStorageTaskDef = new ecs.Ec2TaskDefinition(this, 'VmStorageTaskDef', {
      executionRole: taskExecutionRole,
      networkMode: ecs.NetworkMode.HOST,
    });
    const vmStorageContainer = vmStorageTaskDef.addContainer('VmStorageContainer', {
      image: ecs.ContainerImage.fromRegistry('victoriametrics/vmstorage:latest'),
      // larger memory allocation as its a larger process so I am told. 
      memoryLimitMiB: 1024,
      portMappings: [{ containerPort: 8482 }],
      command: ['-storageDataPath=/victoria-metrics-data'],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'vm-storage',
        logGroup: new logs.LogGroup(this, 'VmStorageLogGroup', {
          logGroupName: '/metropolis/vm-storage',
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
    });

    // grafana does not require a command property as it doesnt communicate with other services. 
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
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
    });

    // ── ECS Services ──────────────────────────────────────────────────────────
    // one per container, each linked to the cluster and task definition.
    const vmAgentService = new ecs.Ec2Service(this, 'VmAgentService', {
      cluster: cluster,
      taskDefinition: vmAgentTaskDef,
      desiredCount: 1,
      minHealthyPercent: 0,
      circuitBreaker: { rollback: true },
    });
    vmAgentService.node.addDependency(asg);

    // the min and max % governs how the instance replacement is handled. DEPLOYMENT only, doesnt
    // affect scaling. 
    // 0 min means it is acceptable for their to be brief times where the service may be down
    // max healthy defaults to 200 unless stated (vm storage, where we CANNOT have two simultaneous
    // instances). 200 means that two can be up at once. 
    const vmInsertService = new ecs.Ec2Service(this, 'VmInsertService', {
      cluster: cluster,
      taskDefinition: vmInsertTaskDef,
      desiredCount: 1,
      minHealthyPercent: 0,
      circuitBreaker: { rollback: true },
    });
    vmInsertService.node.addDependency(asg);

    const vmSelectService = new ecs.Ec2Service(this, 'VmSelectService', {
      cluster: cluster,
      taskDefinition: vmSelectTaskDef,
      desiredCount: 1,
      minHealthyPercent: 0,
      // cb ensures that repeated failed deployments trigger a rollback to previous success deployment. 
      circuitBreaker: { rollback: true },
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
      circuitBreaker: { rollback: true },
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
    // sits in the public subnet, listeners on port 8429 (metrics) and 3000 (Grafana)
    const alb = new elbv2.ApplicationLoadBalancer(this, 'MetropolisALB', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // both these listeners will need HTTPS protocol in production. 
    // open: false:albSg already defines inbound rules, prevents CDK adding a duplicate 0.0.0.0/0 ingress.
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
      // placeholder:real implementation reads from VM/Grafana and writes to RDS
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
