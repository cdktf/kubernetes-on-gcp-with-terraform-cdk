import { Construct } from "constructs";
import { App, TerraformStack } from "cdktf";
import { DockerProvider } from "./.gen/providers/docker/docker-provider";
import { KubernetesProvider } from "./.gen/providers/kubernetes/kubernetes-provider";
import * as fs from "fs";
import * as path from "path";
import { Namespace } from "./.gen/providers/kubernetes/namespace";
import { NAMESPACE } from "./config";
import { application } from "./services";
import { TerraformGoogleModulesKubernetesEngineGoogleModulesAuth as GKEAuth } from "./.gen/modules/terraform-google-modules/kubernetes-engine/google/modules/auth";
import { File } from "./.gen/providers/local/file";
import { HelmProvider } from "./.gen/providers/helm/helm-provider";
import { Release } from "./.gen/providers/helm/release";
import {
  ContainerCluster,
  ContainerNodePool,
  GoogleProvider,
  ServiceAccount,
} from "@cdktf/provider-google";

const KUBECONFIG_PATH = path.resolve(__dirname, "../kubeconfig.yaml");

class InfrastructureLayer extends TerraformStack {
  constructor(scope: Construct, name: string) {
    super(scope, name);

    new GoogleProvider(this, "providers", {
      zone: "us-west1",
      project: "dschmidt-cdk-test",
    });

    const sa = new ServiceAccount(this, "sa", {
      accountId: "cluster-admin",
      displayName: "Cluster Admin",
    });

    const cluster = new ContainerCluster(this, "cluster", {
      name: "cluster",
      removeDefaultNodePool: true,
      initialNodeCount: 1,
    });

    new ContainerNodePool(this, "main-pool", {
      name: "main",
      cluster: cluster.name,
      nodeConfig: [
        {
          preemptible: true,
          machineType: "e2-medium",
          serviceAccount: sa.email,
          oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
        },
      ],
    });

    const auth = new GKEAuth(this, "auth", {
      clusterName: cluster.name,
      location: cluster.location,
      projectId: cluster.project,
    });

    // For the application layer
    new File(this, "kubeconfig", {
      filename: KUBECONFIG_PATH,
      content: auth.kubeconfigRawOutput,
    });

    new KubernetesProvider(this, "kubernetes", {
      clusterCaCertificate: auth.clusterCaCertificateOutput,
      host: auth.hostOutput,
      token: auth.tokenOutput,
    });

    new Namespace(this, "ns", {
      metadata: [
        {
          name: NAMESPACE,
        },
      ],
    });

    new HelmProvider(this, "helm", {
      kubernetes: [
        {
          clusterCaCertificate: auth.clusterCaCertificateOutput,
          host: auth.hostOutput,
          token: auth.tokenOutput,
        },
      ],
    });

    new Release(this, "cert-manager", {
      name: "cert-manager",
      repository: "https://charts.jetstack.io",
      chart: "cert-manager",
      createNamespace: true,
      namespace: "cert-manager",
      version: "v1.3.1",
    });
  }
}

class ApplicationLayer extends TerraformStack {
  constructor(scope: Construct, name: string) {
    super(scope, name);

    new DockerProvider(this, "docker");
    new KubernetesProvider(this, "k8s", {
      configPath: KUBECONFIG_PATH,
    });

    const servicePath = path.resolve(__dirname, "../services");
    fs.readdirSync(servicePath).forEach((p) =>
      application(this, path.resolve(servicePath, p))
    );
  }
}

const app = new App();
new InfrastructureLayer(app, "infrastructure");
new ApplicationLayer(app, "applications");
app.synth();
