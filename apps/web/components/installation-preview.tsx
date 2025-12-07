"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Terminal, ExternalLink, Copy } from "lucide-react"
import { useState } from "react"

export function InstallationPreview() {
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null)

  const copyToClipboard = (text: string, commandId: string) => {
    navigator.clipboard.writeText(text)
    setCopiedCommand(commandId)
    setTimeout(() => setCopiedCommand(null), 2000)
  }

  const installationSteps = [
    {
      id: "setup",
      title: "1. Setup Environment",
      commands: ["export AWS_PROFILE=your-profile", "export AWS_REGION=us-east-1", "terraform --version"],
    },
    {
      id: "init",
      title: "2. Initialize Terraform",
      commands: ["cd terraform-infrastructure", "terraform init", "terraform plan"],
    },
    {
      id: "deploy",
      title: "3. Deploy Infrastructure",
      commands: ["terraform apply", "kubectl get nodes", "argocd app list"],
    },
  ]

  return (
    <Card className="mb-8 border-0 bg-card/80 backdrop-blur-sm shadow-lg">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="font-serif text-xl">Quick Installation Guide</CardTitle>
            <CardDescription>Get started with these essential commands</CardDescription>
          </div>
          <Button variant="outline" className="bg-transparent" onClick={() => (window.location.href = "/installation")}>
            <ExternalLink className="w-4 h-4 mr-2" />
            Full Guide
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          {installationSteps.map((step, stepIndex) => (
            <div key={step.id} className="space-y-3">
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="bg-cyan-100 text-cyan-800">
                  Step {stepIndex + 1}
                </Badge>
                <h4 className="font-semibold text-foreground">{step.title}</h4>
              </div>
              <div className="space-y-2">
                {step.commands.map((command, commandIndex) => (
                  <div
                    key={commandIndex}
                    className="flex items-center gap-2 p-3 bg-gray-900 rounded-lg text-green-400 font-mono text-sm"
                  >
                    <Terminal className="w-4 h-4 text-gray-400 flex-shrink-0" />
                    <code className="flex-1">{command}</code>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0 text-gray-400 hover:text-white hover:bg-gray-700"
                      onClick={() => copyToClipboard(command, `${step.id}-${commandIndex}`)}
                    >
                      {copiedCommand === `${step.id}-${commandIndex}` ? (
                        <span className="text-xs">✓</span>
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <div className="flex items-start gap-3">
            <div className="p-1 bg-blue-200 rounded-full">
              <Terminal className="w-4 h-4 text-blue-800" />
            </div>
            <div>
              <h4 className="font-semibold text-blue-800 mb-1">Prerequisites</h4>
              <ul className="text-sm text-blue-700 space-y-1">
                <li>• AWS CLI configured with appropriate permissions</li>
                <li>• Terraform v1.5.0 or later installed</li>
                <li>• kubectl configured for your cluster</li>
                <li>• ArgoCD CLI installed (optional)</li>
              </ul>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
