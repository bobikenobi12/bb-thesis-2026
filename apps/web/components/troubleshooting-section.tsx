"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ChevronDown, ChevronRight, AlertTriangle, Terminal } from "lucide-react"
import { useState } from "react"

export function TroubleshootingSection() {
  const [openIssues, setOpenIssues] = useState<string[]>([])

  const toggleIssue = (issueId: string) => {
    setOpenIssues((prev) => (prev.includes(issueId) ? prev.filter((id) => id !== issueId) : [...prev, issueId]))
  }

  const troubleshootingIssues = [
    {
      id: "aws-permissions",
      title: "AWS Permission Denied Errors",
      description: "Issues with AWS credentials or insufficient permissions",
      solution: `Ensure your AWS user has the following permissions:
- EC2 full access
- EKS full access
- IAM full access
- VPC full access
- RDS full access
- ElastiCache full access

Check your credentials:`,
      commands: ["aws sts get-caller-identity", "aws iam get-user"],
    },
    {
      id: "terraform-state",
      title: "Terraform State Lock Issues",
      description: "State file is locked or corrupted",
      solution: `If Terraform state is locked, you can force unlock it:`,
      commands: [
        "terraform force-unlock <LOCK_ID>",
        "# Or delete the state lock manually if needed",
        'aws dynamodb delete-item --table-name terraform-state-lock --key \'{"LockID":{"S":"<LOCK_ID>"}}\'',
      ],
    },
    {
      id: "eks-connection",
      title: "Cannot Connect to EKS Cluster",
      description: "kubectl commands fail with connection errors",
      solution: `Update your kubeconfig and verify cluster status:`,
      commands: [
        "aws eks update-kubeconfig --region $AWS_REGION --name $PROJECT_NAME-eks",
        "kubectl config current-context",
        "kubectl cluster-info",
        "aws eks describe-cluster --name $PROJECT_NAME-eks",
      ],
    },
    {
      id: "node-not-ready",
      title: "EKS Nodes Not Ready",
      description: "Worker nodes are in NotReady state",
      solution: `Check node status and logs:`,
      commands: [
        "kubectl get nodes -o wide",
        "kubectl describe node <NODE_NAME>",
        "kubectl get pods -n kube-system",
        "# Check if node group is healthy",
        "aws eks describe-nodegroup --cluster-name $PROJECT_NAME-eks --nodegroup-name workers",
      ],
    },
    {
      id: "argocd-access",
      title: "Cannot Access ArgoCD UI",
      description: "ArgoCD interface is not accessible",
      solution: `Verify ArgoCD installation and access:`,
      commands: [
        "kubectl get pods -n argocd",
        "kubectl get svc -n argocd",
        "# Port forward to access UI",
        "kubectl port-forward svc/argocd-server -n argocd 8080:443",
        "# Get admin password",
        "kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d",
      ],
    },
    {
      id: "dns-issues",
      title: "DNS Resolution Problems",
      description: "Applications cannot resolve DNS names",
      solution: `Check DNS configuration and CoreDNS:`,
      commands: [
        "kubectl get pods -n kube-system -l k8s-app=kube-dns",
        "kubectl logs -n kube-system -l k8s-app=kube-dns",
        "# Test DNS resolution",
        "kubectl run -it --rm debug --image=busybox --restart=Never -- nslookup kubernetes.default",
      ],
    },
  ]

  return (
    <Card className="mb-8 border-0 bg-card/80 backdrop-blur-sm shadow-lg">
      <CardHeader>
        <CardTitle className="font-serif text-xl">Troubleshooting Guide</CardTitle>
        <CardDescription>Common issues and their solutions</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {troubleshootingIssues.map((issue) => (
            <Card key={issue.id} className="border border-amber-200">
              <Collapsible open={openIssues.includes(issue.id)} onOpenChange={() => toggleIssue(issue.id)}>
                <CollapsibleTrigger asChild>
                  <CardHeader className="cursor-pointer hover:bg-amber-50 transition-colors py-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <AlertTriangle className="w-5 h-5 text-amber-600" />
                        <div>
                          <CardTitle className="text-base font-semibold">{issue.title}</CardTitle>
                          <CardDescription className="text-sm">{issue.description}</CardDescription>
                        </div>
                      </div>
                      {openIssues.includes(issue.id) ? (
                        <ChevronDown className="w-4 h-4" />
                      ) : (
                        <ChevronRight className="w-4 h-4" />
                      )}
                    </div>
                  </CardHeader>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <CardContent className="pt-0">
                    <div className="space-y-3">
                      <p className="text-sm text-muted-foreground whitespace-pre-line">{issue.solution}</p>
                      <div className="space-y-2">
                        {issue.commands.map((command, index) => (
                          <div key={index} className="flex items-start gap-2 p-3 bg-gray-900 rounded-lg">
                            <Terminal className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
                            <pre className="flex-1 text-green-400 font-mono text-sm overflow-x-auto whitespace-pre-wrap">
                              {command}
                            </pre>
                          </div>
                        ))}
                      </div>
                    </div>
                  </CardContent>
                </CollapsibleContent>
              </Collapsible>
            </Card>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
