import { Construct } from "constructs";
import { App, TerraformStack } from "cdktf";
import { DockerProvider } from "./.gen/providers/docker/docker-provider";
import { KubernetesProvider } from "./.gen/providers/kubernetes/kubernetes-provider";
import * as fs from "fs";
import * as path from "path";
import { Namespace } from "./.gen/providers/kubernetes/namespace";
import { CLUSTER_NAME } from "./config";
import { application } from "./services";
import { TerraformGoogleModulesKubernetesEngineGoogleModulesAuth as GKEAuth } from "./.gen/modules/terraform-google-modules/kubernetes-engine/google/modules/auth";
import { File } from "./.gen/providers/local/file";
import { HelmProvider } from "./.gen/providers/helm/helm-provider";
import { Release } from "./.gen/providers/helm/release";
import {
  ContainerCluster,
  ContainerNodePool,
  ContainerRegistry,
  DataGoogleContainerCluster,
  GoogleProvider,
  ProjectIamMember,
  ServiceAccount,
} from "@cdktf/provider-google";

const oauthScopes = [
  "https://www.googleapis.com/auth/devstorage.read_only",
  "https://www.googleapis.com/auth/logging.write",
  "https://www.googleapis.com/auth/monitoring",
  "https://www.googleapis.com/auth/servicecontrol",
  "https://www.googleapis.com/auth/service.management.readonly",
  "https://www.googleapis.com/auth/trace.append",
  "https://www.googleapis.com/auth/cloud-platform",
];

function useGoogle(scope: Construct) {
  new GoogleProvider(scope, "providers", {
    zone: "us-central1-c",
    project: "dschmidt-cdk-test",
  });
}

function useCluster(scope: Construct, name: string) {
  useGoogle(scope);
  const cluster = new DataGoogleContainerCluster(scope, "cluster", {
    name,
  });

  const auth = new GKEAuth(scope, "auth", {
    clusterName: cluster.name,
    location: cluster.location,
    projectId: cluster.project,
  });

  // For the application layer
  new File(scope, "kubeconfig", {
    filename: path.resolve(__dirname, "../kubeconfig.yaml"),
    content: auth.kubeconfigRawOutput,
  });

  new KubernetesProvider(scope, "kubernetes", {
    clusterCaCertificate: auth.clusterCaCertificateOutput,
    host: auth.hostOutput,
    token: auth.tokenOutput,
  });

  return auth;
}

class InfrastructureLayer extends TerraformStack {
  constructor(scope: Construct, name: string) {
    super(scope, name);

    useGoogle(this);

    const sa = new ServiceAccount(this, "sa", {
      accountId: "cluster-admin",
      displayName: "Cluster Admin",
    });

    const pushSa = new ServiceAccount(this, "registry-push", {
      accountId: "registry-push",
      displayName: "RegistryPush",
    });

    new ProjectIamMember(this, "sa-role-binding", {
      role: "roles/storage.admin",
      member: `serviceAccount:${sa.email}`,
    });

    new ProjectIamMember(this, "push-role-binding", {
      role: "roles/storage.admin",
      member: `serviceAccount:${pushSa.email}`,
    });

    new ContainerRegistry(this, "registry", {});

    const cluster = new ContainerCluster(this, "cluster", {
      name: CLUSTER_NAME,
      removeDefaultNodePool: true,
      initialNodeCount: 1,
      nodeConfig: [
        {
          serviceAccount: sa.email,
          oauthScopes,
        },
      ],
    });

    new ContainerNodePool(this, "main-pool", {
      dependsOn: [cluster],
      name: "main",
      cluster: cluster.name,
      nodeCount: 10,
      nodeConfig: [
        {
          preemptible: true,
          machineType: "e2-medium",
          serviceAccount: sa.email,
          oauthScopes,
        },
      ],
    });
  }
}

class BaselineLayer extends TerraformStack {
  constructor(scope: Construct, name: string) {
    super(scope, name);

    const auth = useCluster(this, CLUSTER_NAME);

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
    useCluster(this, CLUSTER_NAME);

    new DockerProvider(this, "docker", {});

    const ns = new Namespace(this, "ns", {
      metadata: [
        {
          name,
        },
      ],
    });

    const servicePath = path.resolve(__dirname, "../services");
    fs.readdirSync(servicePath).forEach((p) =>
      application(this, path.resolve(servicePath, p), ns)
    );
  }
}

const app = new App();
new InfrastructureLayer(app, "infrastructure");
new BaselineLayer(app, "baseline");
new ApplicationLayer(app, "development");
new ApplicationLayer(app, "staging");
new ApplicationLayer(app, "production");
app.synth();
