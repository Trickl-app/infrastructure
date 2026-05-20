import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class InfrastructureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);


    const vpc = new ec2.Vpc(this, 'Vpc', {
      //at current I have left as one az, as we will likley be using EBS, which is scoped to AZ zone.
      maxAzs: 1,
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

    // should allow no outbound traffic, but allow the VPC
    const albSg = new ec2.SecurityGroup(this, 'ALBSg', {
      // ties the SG to the VPC. Just shows it where to live, assigned to nothing as yet. 
      vpc, 
      description: "Security group for Application Load Balancer",
      allowAllOutbound: false,
    });

    const ecsSg = new ec2.SecurityGroup(this, 'ECSSg', {
      vpc,
      description: "Security group for ECS cluster",
      allowAllOutbound: false,
    });

    //RDS security group. 
    // inbound on port 5432
    // ourbound on 5432

    //Lambda Security Group.

    //in and outbound rules for the security groups. 
    albSg.addEgressRule(ecsSg, ec2.Port.tcp(3000))
    albSg.addEgressRule(ecsSg, ec2.Port.tcp(8429))
    ecsSg.addIngressRule(albSg, ec2.Port.tcp(3000))
    ecsSg.addIngressRule(albSg, ec2.Port.tcp(8429))

  }
}
