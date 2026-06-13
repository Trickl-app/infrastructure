import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class NetworkStack extends cdk.Stack {
  // they have to be public for the other stacks (mainly application) to access
  public readonly vpc: ec2.Vpc;
  public readonly albSg: ec2.SecurityGroup;
  public readonly ecsSg: ec2.SecurityGroup;
  public readonly rdsSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      // need 2 for rds but we're really just going to use subnet[0] for our nodes
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // effecient way to allow outbound traffic to s3 instead of just using internet gateway
    this.vpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3
    });

    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      description: "Security group for Application Load Balancer",
      allowAllOutbound: false,
    });


    this.ecsSg = new ec2.SecurityGroup(this, 'EcsSg', {
      vpc: this.vpc,
      description: "Security group for ECS tasks",
      allowAllOutbound: false,
    });

    this.rdsSg = new ec2.SecurityGroup(this, 'RdsSg', {
      vpc: this.vpc,
      description: "Security group for RDS Postgres instance",
      allowAllOutbound: false,
    });

    //LOAD BALANCER

    // Allow inbound metrics from the internet to reach alb; use waf in app stack to confirm permissions
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(9090));
    // Allow inbound HTTPS Grafana traffic
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));
    // HTTP to HTTPS
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));

    // alb to vector
    this.albSg.addEgressRule(this.ecsSg, ec2.Port.tcp(9090));
    // alb health checks vector on this port because vector's health check is dependent on an api located here
    this.albSg.addEgressRule(this.ecsSg, ec2.Port.tcp(8686));
    // alb to grafana
    this.albSg.addEgressRule(this.ecsSg, ec2.Port.tcp(3000));
    // Allow alb to call Cognito's token endpoint to complete OIDC auth.
    // Required because allowAllOutbound is false
    this.albSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));

    //ECS RULES


    this.ecsSg.addIngressRule(this.albSg, ec2.Port.tcp(9090));

    this.ecsSg.addIngressRule(this.albSg, ec2.Port.tcp(8686));

    this.ecsSg.addIngressRule(this.albSg, ec2.Port.tcp(3000));
    // cross node traffic to vmstorage's write port
    this.ecsSg.addIngressRule(this.ecsSg, ec2.Port.tcp(8400));
    // As above but for the read node; this is so vmselect can query.
    this.ecsSg.addIngressRule(this.ecsSg, ec2.Port.tcp(8401));
    // As above but for vmselect; this is so grafana can forward queries to vmselect.
    this.ecsSg.addIngressRule(this.ecsSg, ec2.Port.tcp(8481));
    // egress rules
    // Allow cross node ecs traffic to the vmstorage write port; this is to insert data via vminsert
    this.ecsSg.addEgressRule(this.ecsSg, ec2.Port.tcp(8400));
    // As above but for the read node; this is so vmselect can query.
    this.ecsSg.addEgressRule(this.ecsSg, ec2.Port.tcp(8401));
    // As above but for vmselect; this is so grafana can forward queries to vmselect.
    this.ecsSg.addEgressRule(this.ecsSg, ec2.Port.tcp(8481));
    // Allow EC2 nodes to communicate with our RDS postgres
    this.ecsSg.addEgressRule(this.rdsSg, ec2.Port.tcp(5432));
    // Allow EC2 instances to pull container images, register the ECS agent, and write CloudWatch logs.
    this.ecsSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));
    // Allow EC2 instances to resolve hostnames via the VPC DNS resolver.
    this.ecsSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(53));

    //RDS RULES

    // Allow EC2 node to write recommendations to Postgres.
    this.rdsSg.addIngressRule(this.ecsSg, ec2.Port.tcp(5432));
  }
}
