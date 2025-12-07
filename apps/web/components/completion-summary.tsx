import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Cloud, GitBranch, Database, Shield, Settings, Zap } from "lucide-react"

export function CompletionSummary() {
  // This would normally come from the configuration data
  const configSummary = {
    projectName: "my-awesome-project",
    environment: "production",
    awsRegion: "us-east-1",
    containerPlatform: "AI Workloads Ready",
    features: [
      { name: "VPC Creation", enabled: true, icon: <Cloud className="w-4 h-4" /> },
      { name: "GitOps Integration", enabled: true, icon: <GitBranch className="w-4 h-4" /> },
      { name: "Database Auto-scaling", enabled: true, icon: <Database className="w-4 h-4" /> },
      { name: "CloudFront WAF", enabled: false, icon: <Shield className="w-4 h-4" /> },
      { name: "Elastic Redis", enabled: true, icon: <Settings className="w-4 h-4" /> },
      { name: "Karpenter Auto-scaling", enabled: true, icon: <Zap className="w-4 h-4" /> },
    ],
  }

  return (
    <Card className="mb-8 border-0 bg-card/80 backdrop-blur-sm shadow-lg">
      <CardHeader>
        <CardTitle className="font-serif text-xl">Configuration Summary</CardTitle>
        <CardDescription>Review your platform configuration details</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid md:grid-cols-2 gap-6 mb-6">
          <div className="space-y-3">
            <div>
              <h4 className="font-semibold text-sm text-muted-foreground mb-1">Project Name</h4>
              <p className="text-foreground">{configSummary.projectName}</p>
            </div>
            <div>
              <h4 className="font-semibold text-sm text-muted-foreground mb-1">Environment</h4>
              <Badge variant="secondary" className="bg-blue-100 text-blue-800">
                {configSummary.environment}
              </Badge>
            </div>
          </div>
          <div className="space-y-3">
            <div>
              <h4 className="font-semibold text-sm text-muted-foreground mb-1">AWS Region</h4>
              <p className="text-foreground">{configSummary.awsRegion}</p>
            </div>
            <div>
              <h4 className="font-semibold text-sm text-muted-foreground mb-1">Container Platform</h4>
              <Badge variant="secondary" className="bg-purple-100 text-purple-800">
                {configSummary.containerPlatform}
              </Badge>
            </div>
          </div>
        </div>

        <div>
          <h4 className="font-semibold text-sm text-muted-foreground mb-3">Enabled Features</h4>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {configSummary.features.map((feature, index) => (
              <div
                key={index}
                className={`flex items-center gap-2 p-2 rounded-lg border ${
                  feature.enabled
                    ? "bg-green-50 border-green-200 text-green-800"
                    : "bg-gray-50 border-gray-200 text-gray-500"
                }`}
              >
                {feature.icon}
                <span className="text-sm font-medium">{feature.name}</span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
