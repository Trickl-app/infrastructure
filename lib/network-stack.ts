import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class NetworkStack extends cdk.Stack {
  // public properties allow other stacks to reference these resources via props. Necessary for VPC to be
  // accessed within the application stack. 
  public readonly vpc: ec2.Vpc;
  public readonly albSg: ec2.SecurityGroup;
  public readonly ecsSg: ec2.SecurityGroup;
  public readonly rdsSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);


    this.vpc = new ec2.Vpc(this, 'Vpc', {
      // 2 AZs: satisfies RDS subnet group requirement. ASG is pinned to privateSubnets[0] so EBS stays in AZ1.
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          //public subnets
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          // leaving as default
          cidrMask: 24,
        },
        {
          //private subnets
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // ALB sits in the public subnet and receives inbound telemetry (8429) and Grafana (3000) from the internet.
    // allowAllOutbound false — we explicitly control where the ALB can send traffic.
    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      description: "Security group for Application Load Balancer",
      allowAllOutbound: false,
    });

    // ECS tasks sit in the private subnet. Only the ALB and Lambda can initiate inbound connections.
    // allowAllOutbound false — we explicitly control outbound to RDS.
    this.ecsSg = new ec2.SecurityGroup(this, 'EcsSg', {
      vpc: this.vpc,
      description: "Security group for ECS tasks",
      allowAllOutbound: false,
    });

    // RDS sits in the private subnet. Only ECS tasks and Lambda can connect on the Postgres port.
    // No outbound needed — RDS never initiates connections, resources connect to it.
    this.rdsSg = new ec2.SecurityGroup(this, 'RdsSg', {
      vpc: this.vpc,
      description: "Security group for RDS Postgres instance",
      allowAllOutbound: false,
    });

    // --------------- LOAD BALANCER RULES ---------------- //

    // Allow inbound telemetry data from the internet to reach the ALB.
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8429));
    // Allow inbound Grafana dashboard traffic from the internet to reach the ALB.
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3000));

    // Allow the ALB to forward telemetry traffic onwards to the vmagent ECS container.
    this.albSg.addEgressRule(this.ecsSg, ec2.Port.tcp(8429));
    // Allow the ALB to forward Grafana traffic onwards to the Grafana ECS container.
    this.albSg.addEgressRule(this.ecsSg, ec2.Port.tcp(3000));

    // --------------- ECS RULES ---------------- //

    // Allow vmagent to receive telemetry forwarded by the ALB.
    this.ecsSg.addIngressRule(this.albSg, ec2.Port.tcp(8429));
    // Allow Grafana to receive dashboard traffic forwarded by the ALB.
    this.ecsSg.addIngressRule(this.albSg, ec2.Port.tcp(3000));
    // Allow Lambda to reach vmagent to manage scrape configurations.
    this.ecsSg.addIngressRule(this.lambdaSg, ec2.Port.tcp(8429));
    // Allow Lambda to reach Grafana to read dashboard and alert state.
    this.ecsSg.addIngressRule(this.lambdaSg, ec2.Port.tcp(3000));
    // Allow Lambda to query vmselect for time series cardinality data.
    this.ecsSg.addIngressRule(this.lambdaSg, ec2.Port.tcp(8481));

    // Allow EC2 instances to pull container images, register the ECS agent, and write CloudWatch logs.
    this.ecsSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));
    // Allow EC2 instances to resolve hostnames via the VPC DNS resolver.
    this.ecsSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(53));

    // --------------- RDS RULES ---------------- //

    // Allow Lambda to write recommendations to Postgres.
    this.rdsSg.addIngressRule(this.lambdaSg, ec2.Port.tcp(5432));
  }
}
