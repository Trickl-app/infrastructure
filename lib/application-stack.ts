import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
// import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2Actions from 'aws-cdk-lib/aws-elasticloadbalancingv2-actions';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as serviceDiscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
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
  rdsEndpoint: string;
  dbSecret: secretsmanager.ISecret;
}

export class ApplicationStack extends cdk.Stack {
  // props is no longer optional:the VPC and security groups are required to deploy this stack.
  constructor(scope: Construct, id: string, props: ApplicationStackProps) {
    super(scope, id, props);

    // ── Deploy-time parameters ────────────────────────────────────────────────
    const certificateArn = new cdk.CfnParameter(this, 'CertificateArn', {
      type: 'String',
      description: 'ARN of an ACM certificate covering DomainName, used for HTTPS on the ALB.',
    });

    const domainName = new cdk.CfnParameter(this, 'DomainName', {
      type: 'String',
      description: 'The domain/subdomain pointing at this ALB (e.g. grafana.yourdomain.com). Used as the Cognito OIDC callback URL.',
    });

    const vmagentAuthPassword = new cdk.CfnParameter(this, 'VmagentAuthPassword', {
      type: 'String',
      noEcho: true,
      description: 'Password senders must supply when pushing metrics to vmagent (HTTP basic auth).',
    });

    const openAiApiKey = new cdk.CfnParameter(this, 'OpenAiApiKey', {
      type: 'String',
      noEcho: true,
      description: 'OpenAI API key used by the Smart Metrics AI Investigator.',
    });

    // Stored in Secrets Manager so it is never written in plaintext to the
    // task definition. ECS injects it as VMAGENT_AUTH_PASSWORD at container startup.
    const vmagentAuthSecret = new secretsmanager.Secret(this, 'VmagentAuthSecret', {
      secretStringValue: cdk.SecretValue.cfnParameter(vmagentAuthPassword),
    });

    // Stored separately from the vmagent auth secret so AI credentials can be
    // rotated independently. ECS injects it as OPENAI_API_KEY at container startup.
    const openAiApiKeySecret = new secretsmanager.Secret(this, 'OpenAiApiKeySecret', {
      secretStringValue: cdk.SecretValue.cfnParameter(openAiApiKey),
    });

    // ── Cognito ───────────────────────────────────────────────────────────────
    // Self-signup disabled — only admin-created users can authenticate.
    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Domain prefix derived from account ID — globally unique without requiring
    // a user-supplied parameter.
    const userPoolDomain = userPool.addDomain('CognitoDomain', {
      cognitoDomain: {
        domainPrefix: `trickl-${cdk.Aws.ACCOUNT_ID}`,
      },
    });

    const userPoolClient = userPool.addClient('AlbClient', {
      generateSecret: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [`https://${domainName.valueAsString}/oauth2/idpresponse`],
        logoutUrls: [`https://${domainName.valueAsString}`],
      },
    });

    const certificate = acm.Certificate.fromCertificateArn(this, 'Certificate', certificateArn.valueAsString);

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
    const cluster = new ecs.Cluster(this, 'TricklCluster', {
      vpc: props.vpc,
    });

    // ── EC2 Auto Scaling Groups + Capacity Providers ──────────────────────────
    //
    // Each node gets its own ASG and a named capacity provider.
    //
    // Why explicit AutoScalingGroup instead of cluster.addCapacity()?
    // cluster.addCapacity() creates a capacity provider internally but returns
    // only the ASG — you get no reference to the provider. Services need to
    // reference a named capacity provider to pin themselves to a specific node,
    // so we create the provider explicitly and hold onto it.
    //
    // Why EcsOptimizedImage?
    // Without it the EC2 instance boots as a plain Amazon Linux box with no ECS
    // agent. EcsOptimizedImage.amazonLinux2() bakes the agent in so the instance
    // registers with the cluster automatically on first boot.

    // ── Interface Node ────────────────────────────────────────────────────────
    // Hosts: vmagent, vminsert, vector, grafana, smart-metrics.
    // vmagent, vminsert, and grafana have low continuous resource usage.
    // Vector handles the full raw metric stream and is the baseline sizing driver.
    // Smart-metrics is mostly idle but fires a demanding cron job every 24h
    // (API scraping, data sorting) lasting a couple of minutes — size the instance
    // to absorb that burst without starving the other services.
    // No AZ constraint — no EBS on this node.
    const interfaceAsg = new autoscaling.AutoScalingGroup(this, 'InterfaceASG', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2(),
      vpc: props.vpc,
      desiredCapacity: 1,
      maxCapacity: 1,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    interfaceAsg.addSecurityGroup(props.ecsSg);
    const interfaceCP = new ecs.AsgCapacityProvider(this, 'InterfaceCP', {
      autoScalingGroup: interfaceAsg,
      enableManagedScaling: false,
      enableManagedTerminationProtection: false,
    });
    cluster.addAsgCapacityProvider(interfaceCP);

    // ── Select Node ───────────────────────────────────────────────────────────
    // Hosts: vmselect only.
    // Query processing is CPU/memory intensive per query but does no persistent I/O.
    // t3.small is the starting point; vertically scale as dashboard load grows.
    // No AZ constraint — no EBS on this node.
    const selectAsg = new autoscaling.AutoScalingGroup(this, 'SelectASG', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2(),
      vpc: props.vpc,
      desiredCapacity: 1,
      maxCapacity: 1,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    selectAsg.addSecurityGroup(props.ecsSg);
    const selectCP = new ecs.AsgCapacityProvider(this, 'SelectCP', {
      autoScalingGroup: selectAsg,
      enableManagedScaling: false,
      enableManagedTerminationProtection: false,
    });
    cluster.addAsgCapacityProvider(selectCP);

    // ── Storage Node ──────────────────────────────────────────────────────────
    // Hosts: vmstorage only.
    // Pinned to privateSubnets[0] — EBS volumes are AZ-specific, so the instance
    // and its data volume must always land in the same AZ. Changing this subnet
    // would cause the new instance to boot in a different AZ from the EBS volume,
    // making the data inaccessible.
    // deleteOnTermination: false ensures the data volume outlives instance replacement.
    const storageAsg = new autoscaling.AutoScalingGroup(this, 'StorageASG', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2(),
      vpc: props.vpc,
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
    });
    storageAsg.addSecurityGroup(props.ecsSg);
    const storageCP = new ecs.AsgCapacityProvider(this, 'StorageCP', {
      autoScalingGroup: storageAsg,
      enableManagedScaling: false,
      enableManagedTerminationProtection: false,
    });
    cluster.addAsgCapacityProvider(storageCP);

    // Interface node bootstrap — run on every boot.
    // Creates the shared vmagent config directory and seeds a valid empty
    // aggregations.yml so vmagent can start before smart-metrics has written
    // its first real config. Smart-metrics overwrites this file on its first
    // cron run and signals vmagent to hot-reload.
    // -n flag: only write the file if it doesn't already exist (idempotent on reboot).
    interfaceAsg.userData.addCommands(
      'mkdir -p /shared/vmagent',
      '[ -f /shared/vmagent/aggregations.yml ] || echo "[]" > /shared/vmagent/aggregations.yml',
      '[ -f /shared/vmagent/relabel.yml ] || echo "[]" > /shared/vmagent/relabel.yml',
      '[ -f /shared/vmagent/vector_relabel.yml ] || printf \'- source_labels: [__name__]\\n  regex: .+:.+\\n  action: drop\\n\' > /shared/vmagent/vector_relabel.yml',
    );

    // EBS mount commands — run on every boot of the storage node.
    // blkid check prevents mkfs from reformatting an already-populated volume on reboot.
    storageAsg.userData.addCommands(
      'blkid /dev/xvdb || mkfs -t xfs /dev/xvdb',
      'mkdir -p /data/vm-storage',
      'mount /dev/xvdb /data/vm-storage || true',
      "echo '/dev/xvdb /data/vm-storage xfs defaults,nofail 0 2' >> /etc/fstab",
    );

    // cloud map namespace to facilitate service discovery
    const namespace = new serviceDiscovery.PrivateDnsNamespace(this, "Namespace", {
      name: "trickl.local",
      vpc: props.vpc
    });
    
    // ── IAM Roles ─────────────────────────────────────────────────────────────

    // role to ensure ECS can write output logs to cloudwatch and pull container Images from ECS
    const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      // assumedBy tells AWS that ECS (not a user) is the one using this role.
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Vector's task role — distinct from the execution role.
    // The execution role lets ECS pull images and write CloudWatch logs.
    // The task role is what the running Vector container uses to call AWS APIs,
    // specifically writing raw metrics to the S3 bucket.
    const vectorTaskRole = new iam.Role(this, 'VectorTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    props.metricsBucket.grantWrite(vectorTaskRole);
    // grantWrite only covers object-level actions (PutObject etc. on bucket/*).
    // Vector's S3 sink healthcheck calls HeadBucket, which requires s3:ListBucket
    // on the bucket ARN itself — without it Vector logs "Invalid credentials" and
    // refuses to start writing. Grant it explicitly on the bucket ARN here.
    vectorTaskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [props.metricsBucket.bucketArn],
    }));

    //role for ASG to register EC2 instances with ECS cluster
    //EDIT: This is commented out for now because it appears it might not be 
    // needed as an IAM role with the same permissions is auto added. 
    // const ec2InstanceRole = new iam.Role(this, 'Ec2InstanceRole', {
    //   assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    //   managedPolicies: [
    //     iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
    //   ],
    // });


    // ── Application Load Balancer ─────────────────────────────────────────────
    // Declared here — before the task definitions — so alb.loadBalancerDnsName is
    // available as a CloudFormation token when building the grafana container's
    // environment variables. Listeners are added later, after the services exist.
    const alb = new elbv2.ApplicationLoadBalancer(this, 'TricklALB', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // ── ECS Task Definitions ──────────────────────────────────────────────────
    // Instructions for ECS on how to run the containers. Just a spec
    // executionRole grants ECS permission to write logs to CloudWatch for each task.
    // addContainer attaches the container spec:image, memory, port, and log destination.

    const vmAgentTaskDef = new ecs.Ec2TaskDefinition(this, 'VmAgentTaskDef', {
      executionRole: taskExecutionRole,
      networkMode: ecs.NetworkMode.HOST,
    });
    vmAgentTaskDef.addVolume({
      name: "vmagent-config",
      host: { sourcePath: "/shared/vmagent" }
    });
    const VmAgentContainer = vmAgentTaskDef.addContainer('VmAgentContainer', {
      image: ecs.ContainerImage.fromRegistry('victoriametrics/vmagent:latest'),
      memoryLimitMiB: 512,
      portMappings: [{ containerPort: 8429 }],
      // entryPoint overrides the image's default entrypoint with a shell so that
      // $VMAGENT_AUTH_PASSWORD (injected by ECS from Secrets Manager) is expanded
      // before vmagent receives it as a flag value. Without a shell, the literal
      // string "$VMAGENT_AUTH_PASSWORD" would be passed to vmagent unchanged.
      entryPoint: ['/bin/sh', '-c'],
      command: [
        // Single string — the shell expands $VMAGENT_AUTH_PASSWORD then exec's vmagent.
        // Seeds vector_relabel.yml if absent (user data only runs on first boot;
        // service updates reuse the existing instance without re-running user data).
        [
          '[ -f /etc/vmagent/vector_relabel.yml ] || printf \'- source_labels: [__name__]\\n  regex: .+:.+\\n  action: drop\\n\' > /etc/vmagent/vector_relabel.yml;',
          '/vmagent-prod',
          '--httpAuth.username=metrics',
          '--httpAuth.password=$VMAGENT_AUTH_PASSWORD',
          '--remoteWrite.tmpDataPath=/vmagentdata',
          // url[0]: vminsert receives only aggregated and relabeled metrics
          '--remoteWrite.url=http://localhost:8480/insert/0/prometheus',
          '--remoteWrite.streamAggr.config=/etc/vmagent/aggregations.yml',
          '--remoteWrite.relabelConfig=/etc/vmagent/relabel.yml',
          // url[1]: vector receives raw metrics only — aggregated output (colon-suffixed) is dropped
          '--remoteWrite.url=http://localhost:9090/',
          '--remoteWrite.relabelConfig=/etc/vmagent/vector_relabel.yml',
        ].join(' '),
      ],
      secrets: {
        VMAGENT_AUTH_PASSWORD: ecs.Secret.fromSecretsManager(vmagentAuthSecret),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'vm-agent',
        logGroup: new logs.LogGroup(this, 'VmAgentLogGroup', {
          logGroupName: '/trickl/vm-agent',
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
    });
    VmAgentContainer.addMountPoints({
      containerPath: "/etc/vmagent",
      sourceVolume: "vmagent-config",
      readOnly: false
    })


    const vmInsertTaskDef = new ecs.Ec2TaskDefinition(this, 'VmInsertTaskDef', {
      executionRole: taskExecutionRole,
      networkMode: ecs.NetworkMode.HOST,
    });
    vmInsertTaskDef.addContainer('VmInsertContainer', {
      image: ecs.ContainerImage.fromRegistry('victoriametrics/vminsert:latest'),
      memoryLimitMiB: 512,
      portMappings: [{ containerPort: 8480 }],
      command: [
        '-storageNode=vmstorage.trickl.local:8400',
        '-enableMetadata=true',
      ],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'vm-insert',
        logGroup: new logs.LogGroup(this, 'VmInsertLogGroup', {
          logGroupName: '/trickl/vm-insert',
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
    });

    // vmselect sits alone on the select node with no co-located containers, so
    // HOST mode buys nothing. AWS_VPC gives each task its own ENI, which lets
    // Cloud Map register a proper A record instead of the SRV record CDK forces
    // for HOST/bridge mode — plain hostname lookups (from grafana etc.) need A.
    const vmSelectTaskDef = new ecs.Ec2TaskDefinition(this, 'VmSelectTaskDef', {
      executionRole: taskExecutionRole,
      networkMode: ecs.NetworkMode.AWS_VPC,
    });
    vmSelectTaskDef.addContainer('VmSelectContainer', {
      image: ecs.ContainerImage.fromRegistry('victoriametrics/vmselect:latest'),
      memoryLimitMiB: 512,
      portMappings: [{ containerPort: 8481 }],
      command: [
        '-storageNode=vmstorage.trickl.local:8401',
        '--cacheDataPath=/cache',
      ],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'vm-select',
        logGroup: new logs.LogGroup(this, 'VmSelectLogGroup', {
          logGroupName: '/trickl/vm-select',
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
    });

    // VM Storage needs a volume mount for the EBS volume:handled in the EBS section below.
    // the container reference is stored so we can call addMountPoints() on it later.
    // Same reasoning as vmselect — AWS_VPC mode for A record DNS. Host volumes
    // (for EBS) still work in AWS_VPC mode; it only affects the network interface.
    const vmStorageTaskDef = new ecs.Ec2TaskDefinition(this, 'VmStorageTaskDef', {
      executionRole: taskExecutionRole,
      networkMode: ecs.NetworkMode.AWS_VPC,
    });
    const vmStorageContainer = vmStorageTaskDef.addContainer('VmStorageContainer', {
      image: ecs.ContainerImage.fromRegistry('victoriametrics/vmstorage:latest'),
      // larger memory allocation as its a larger process so I am told. 
      memoryLimitMiB: 1024,
      portMappings: [
        { containerPort: 8482 }, // HTTP API (health, metrics, UI)
        { containerPort: 8400 }, // vminsert write protocol
        { containerPort: 8401 }, // vmselect read protocol
      ],
      command: [
        '-storageDataPath=/victoria-metrics-data',
        '--retentionPeriod=1',
      ],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'vm-storage',
        logGroup: new logs.LogGroup(this, 'VmStorageLogGroup', {
          logGroupName: '/trickl/vm-storage',
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
    });

    // grafana is built from a custom Dockerfile that bakes in the plugin and provisioning config.
    // No command override needed — the image's own entrypoint handles startup.
    const grafanaTaskDef = new ecs.Ec2TaskDefinition(this, 'GrafanaTaskDef', {
      executionRole: taskExecutionRole,
      networkMode: ecs.NetworkMode.HOST,
    });
    grafanaTaskDef.addContainer('GrafanaContainer', {
      image: ecs.ContainerImage.fromAsset('../local_host_pipeline/grafana'),
      memoryLimitMiB: 512,
      portMappings: [{ containerPort: 3000 }],
      environment: {
        GF_SECURITY_ADMIN_USER: 'admin',
        // TODO pre-prod: move to Secrets Manager
        GF_SECURITY_ADMIN_PASSWORD: 'admin',
        // HOST mode: Grafana and smart-metrics share the EC2 network namespace,
        // so localhost:3001 resolves correctly. docker-compose uses the service
        // name (http://smart-metrics:3001) instead.
        SMART_METRICS_INTERNAL_URL: 'http://localhost:3001',
        // ALB auth proxy — Grafana trusts the identity header set by the ALB
        // after OIDC authentication, auto-signing users in without a second
        // Grafana login prompt.
        GF_AUTH_PROXY_ENABLED: 'true',
        GF_AUTH_PROXY_HEADER_NAME: 'X-Amzn-Oidc-Identity',
        GF_AUTH_PROXY_HEADER_PROPERTY: 'username',
        GF_AUTH_PROXY_AUTO_SIGN_UP: 'true',
        GF_USERS_AUTO_ASSIGN_ORG_ROLE: 'Admin',
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'grafana',
        logGroup: new logs.LogGroup(this, 'GrafanaLogGroup', {
          logGroupName: '/trickl/grafana',
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
    });

    // vector task definition
    // fromAsset builds the Dockerfile at the given path — vector.toml is COPY'd into
    // the image at build time, so no host volume is needed (and mounting one would
    // shadow the baked-in config, leaving the container with an empty /etc/vector).
    const vectorTaskDef = new ecs.Ec2TaskDefinition(this, "VectorTaskDef", {
      executionRole: taskExecutionRole,
      taskRole: vectorTaskRole,
      networkMode: ecs.NetworkMode.HOST
    });
    vectorTaskDef.addContainer("VectorContainer", {
      image: ecs.ContainerImage.fromAsset('../local_host_pipeline/vector'),
      memoryLimitMiB: 512,
      portMappings: [{ containerPort: 9090 }],
      command: ['--config', '/etc/vector/vector.toml'],
      // bucket name is injected at runtime; vector.toml references it as ${S3_BUCKET_NAME}.
      // auth is handled by the IAM task role — no AWS credentials needed here.
      environment: {
        S3_BUCKET_NAME: props.metricsBucket.bucketName,
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'vector',
        logGroup: new logs.LogGroup(this, 'VectorLogGroup', {
          logGroupName: '/trickl/vector',
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
    });

    // ── Smart Metrics ─────────────────────────────────────────────────────────
    // Persistent API server on port 3001; internal scheduler fires the cron job
    // every 24h. Shares /shared/vmagent with vmagent so it can write
    // aggregations.yml and trigger a hot reload.
    const smartMetricsTaskDef = new ecs.Ec2TaskDefinition(this, 'SmartMetricsTaskDef', {
      executionRole: taskExecutionRole,
      networkMode: ecs.NetworkMode.HOST,
    });
    smartMetricsTaskDef.addVolume({
      name: 'vmagent-config',
      host: { sourcePath: '/shared/vmagent' },
    });
    const smartMetricsContainer = smartMetricsTaskDef.addContainer('SmartMetricsContainer', {
      image: ecs.ContainerImage.fromAsset('../local_host_pipeline/smart_metrics'),
      memoryLimitMiB: 256,
      portMappings: [{ containerPort: 3001 }],
      environment: {
        // same node as grafana and vmagent — HOST mode means localhost resolves correctly
        GRAFANA_URL: 'http://localhost:3000',
        GRAFANA_USER: 'admin',
        // TODO pre-prod: move to Secrets Manager
        GRAFANA_PASSWORD: 'admin',
        VMSELECT_ENDPOINT: 'http://vmselect.trickl.local:8481/select/0/prometheus/api/v1',
        YAML_PATH: '/mnt/vmagent/aggregations.yml',
        DROP_LABEL_PATH: '/mnt/vmagent/relabel.yml',
        VMAGENT_URL: 'http://localhost:8429',
        VMAGENT_AUTH_USERNAME: 'metrics',
        OPENAI_MODEL: 'gpt-4.1-mini',
        // non-sensitive DB connection fields passed as plain env vars
        DB_HOST: props.rdsEndpoint,
        DB_PORT: '5432',
        DB_NAME: 'trickl',
      },
      // DB_USER and DB_PASSWORD are pulled from the RDS-generated Secrets Manager secret
      // at container startup — never stored in plaintext in the task definition.
      // NOTE: database.ts currently reads DATABASE_URL as a single string.
      // Update it to construct the connection string from DB_HOST, DB_PORT,
      // DB_NAME, DB_USER, and DB_PASSWORD before deploying.
      secrets: {
        DB_USER: ecs.Secret.fromSecretsManager(props.dbSecret, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(props.dbSecret, 'password'),
        OPENAI_API_KEY: ecs.Secret.fromSecretsManager(openAiApiKeySecret),
        VMAGENT_AUTH_PASSWORD: ecs.Secret.fromSecretsManager(vmagentAuthSecret),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'smart-metrics',
        logGroup: new logs.LogGroup(this, 'SmartMetricsLogGroup', {
          logGroupName: '/trickl/smart-metrics',
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
    });
    smartMetricsContainer.addMountPoints({
      containerPath: '/mnt/vmagent',
      sourceVolume: 'vmagent-config',
      readOnly: false,
    });

    // smart-metrics runs as a persistent service on the interface node.
    // It serves the grafana plugin's API on port 3001 and handles its own
    // 24h cron job internally — no EventBridge needed.
    const smartMetricsService = new ecs.Ec2Service(this, 'SmartMetricsService', {
      cluster,
      taskDefinition: smartMetricsTaskDef,
      desiredCount: 1,
      minHealthyPercent: 0,
      circuitBreaker: { rollback: true },
      capacityProviderStrategies: [{
        capacityProvider: interfaceCP.capacityProviderName,
        weight: 1,
      }],
    });
    smartMetricsService.node.addDependency(interfaceCP);

    // ── ECS Services ──────────────────────────────────────────────────────────
    //
    // capacityProviderStrategies pins each service to its designated node.
    // Without this, ECS treats all three nodes as a shared pool and places
    // tasks arbitrarily — vmstorage could land on a node with no EBS volume.
    //
    // node.addDependency ensures CloudFormation waits for the capacity provider
    // to be registered before creating the service, avoiding a race where ECS
    // tries to place the task before the target instance exists.
    //
    // minHealthyPercent / maxHealthyPercent govern rolling deployment behaviour
    // (not autoscaling). 0 min means brief downtime is acceptable during deploys.
    // vmstorage uses maxHealthyPercent: 100 to enforce stop-before-start,
    // preventing two storage tasks from ever writing to the same EBS volume.

    const vmAgentService = new ecs.Ec2Service(this, 'VmAgentService', {
      cluster: cluster,
      taskDefinition: vmAgentTaskDef,
      desiredCount: 1,
      minHealthyPercent: 0,
      circuitBreaker: { rollback: true },
      capacityProviderStrategies: [{
        capacityProvider: interfaceCP.capacityProviderName,
        weight: 1,
      }],
    });
    vmAgentService.node.addDependency(interfaceCP);

    const vmInsertService = new ecs.Ec2Service(this, 'VmInsertService', {
      cluster: cluster,
      taskDefinition: vmInsertTaskDef,
      desiredCount: 1,
      minHealthyPercent: 0,
      circuitBreaker: { rollback: true },
      capacityProviderStrategies: [{
        capacityProvider: interfaceCP.capacityProviderName,
        weight: 1,
      }],
    });
    vmInsertService.node.addDependency(interfaceCP);

    const vmSelectService = new ecs.Ec2Service(this, 'VmSelectService', {
      cluster: cluster,
      taskDefinition: vmSelectTaskDef,
      desiredCount: 1,
      minHealthyPercent: 0,
      circuitBreaker: { rollback: true },
      capacityProviderStrategies: [{
        capacityProvider: selectCP.capacityProviderName,
        weight: 1,
      }],
      // registers vmselect.trickl.local in Route 53 so grafana and other
      // internal callers can resolve it without hardcoding an IP address.
      cloudMapOptions: {
        name: 'vmselect',
        cloudMapNamespace: namespace,
        // HOST network mode: CDK defaults to SRV records (like bridge mode), but
        // plain hostname lookups query for A records. Force A so that
        // vmselect.trickl.local resolves correctly from grafana.
        dnsRecordType: serviceDiscovery.DnsRecordType.A,
      },
    });
    vmSelectService.node.addDependency(selectCP);
    // Ec2Service doesn't expose vpcSubnets/securityGroups for awsvpc mode (those
    // are FargateService props), so we set networkConfiguration via escape hatch.
    (vmSelectService.node.defaultChild as ecs.CfnService).networkConfiguration = {
      awsvpcConfiguration: {
        subnets: props.vpc.privateSubnets.map(s => s.subnetId),
        securityGroups: [props.ecsSg.securityGroupId],
      },
    };

    const vmStorageService = new ecs.Ec2Service(this, 'VmStorageService', {
      cluster: cluster,
      taskDefinition: vmStorageTaskDef,
      desiredCount: 1,
      // stop-before-start: prevents two vmstorage tasks from running simultaneously
      // and writing to the same EBS volume, which would corrupt the data.
      maxHealthyPercent: 100,
      minHealthyPercent: 0,
      circuitBreaker: { rollback: true },
      capacityProviderStrategies: [{
        capacityProvider: storageCP.capacityProviderName,
        weight: 1,
      }],
      // registers vmstorage.trickl.local so vminsert and vmselect can reach it
      // across nodes without hardcoded addresses.
      cloudMapOptions: {
        name: 'vmstorage',
        cloudMapNamespace: namespace,
        // Same reason as vmselect — force A records for plain hostname resolution.
        dnsRecordType: serviceDiscovery.DnsRecordType.A,
      },
    });
    vmStorageService.node.addDependency(storageCP);
    // Same escape hatch as vmselect. Storage node is always in privateSubnets[0]
    // (AZ-pinned for EBS), but we pass all private subnets — ECS uses whichever
    // matches the AZ of the EC2 instance the capacity provider placed the task on.
    (vmStorageService.node.defaultChild as ecs.CfnService).networkConfiguration = {
      awsvpcConfiguration: {
        subnets: props.vpc.privateSubnets.map(s => s.subnetId),
        securityGroups: [props.ecsSg.securityGroupId],
      },
    };

    const grafanaService = new ecs.Ec2Service(this, 'GrafanaService', {
      cluster: cluster,
      taskDefinition: grafanaTaskDef,
      desiredCount: 1,
      minHealthyPercent: 0,
      circuitBreaker: { rollback: true },
      capacityProviderStrategies: [{
        capacityProvider: interfaceCP.capacityProviderName,
        weight: 1,
      }],
    });
    grafanaService.node.addDependency(interfaceCP);

    const vectorService = new ecs.Ec2Service(this, 'VectorService', {
      cluster: cluster,
      taskDefinition: vectorTaskDef,
      desiredCount: 1,
      minHealthyPercent: 0,
      circuitBreaker: { rollback: true },
      capacityProviderStrategies: [{
        capacityProvider: interfaceCP.capacityProviderName,
        weight: 1,
      }],
    });
    vectorService.node.addDependency(interfaceCP);

    // ── ALB Listeners ─────────────────────────────────────────────────────────
    // ALB itself is declared before the task definitions so its DNS name token
    // is available when building container environment variables.
    // Listeners are added here, after the services, because they need service references.
    // Both listeners will need HTTPS protocol in production. 
    // open: false:albSg already defines inbound rules, prevents CDK adding a duplicate 0.0.0.0/0 ingress.
    // ── HTTP → HTTPS redirect ─────────────────────────────────────────────────
    // Port 80 accepts plain HTTP and issues a 301 to the HTTPS equivalent.
    // No backend target needed — the redirect is handled entirely by the ALB.
    alb.addListener('HttpRedirectListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    const telemetryListener = alb.addListener('TelemetryListener', {
      port: 8429,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
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

    // OIDC authentication is enforced at the ALB before any request reaches
    // Grafana. The Grafana container trusts the X-Amzn-Oidc-Identity header
    // set by the ALB to auto-sign users in (GF_AUTH_PROXY_* env vars).
    const grafanaTargetGroup = new elbv2.ApplicationTargetGroup(this, 'GrafanaTargetGroup', {
      vpc: props.vpc,
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

    const grafanaListener = alb.addListener('GrafanaListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      open: false,
    });
    grafanaListener.addAction('GrafanaOidcAction', {
      action: new elbv2Actions.AuthenticateCognitoAction({
        userPool,
        userPoolClient,
        userPoolDomain,
        next: elbv2.ListenerAction.forward([grafanaTargetGroup]),
      }),
    });


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

    // ── Outputs ───────────────────────────────────────────────────────────────
    // After deploying, point your domain's DNS at this value.
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: alb.loadBalancerDnsName,
      description: 'Point your domain DNS (CNAME or ALIAS) at this ALB address.',
    });
  }
}
