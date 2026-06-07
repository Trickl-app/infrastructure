import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

// defines what this stack needs from other stacks
// extends cdk.StackProps so standard props like env are still accepted.
interface DataStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  rdsSg: ec2.ISecurityGroup;
}

export class DataStack extends cdk.Stack {
  public readonly rdsEndpoint: string;
  public readonly metricsBucket: s3.Bucket;
  public readonly dbSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    // got retain on for longevity after a stack teardown
    this.metricsBucket = new s3.Bucket(this, 'MetricsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const db = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_15,
      }),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.rdsSg],
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      multiAz: false,
      allocatedStorage: 20,
      deletionProtection: true,
      // this isn't the password, we're just generating it here
      credentials: rds.Credentials.fromGeneratedSecret('trickl'),
      databaseName: 'trickl',
    });

    this.rdsEndpoint = db.instanceEndpoint.hostname;
    this.dbSecret = db.secret!;
  }
}
