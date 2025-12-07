import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { CheckCircle, Clock, Zap } from "lucide-react"

export function FeatureShowcase() {
  return (
    <div className="mb-12">
      <div className="text-center mb-8">
        <h2 className="font-serif text-3xl font-bold text-foreground mb-4">Why Choose ItGix Platform?</h2>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
          Built for enterprise teams who demand reliability, security, and scalability in their development workflows.
        </p>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        <Card className="border-0 bg-gradient-to-br from-green-50 to-background">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 p-3 bg-green-600 rounded-full w-fit">
              <CheckCircle className="w-8 h-8 text-white" />
            </div>
            <CardTitle className="font-serif text-xl">Enterprise Ready</CardTitle>
            <CardDescription>Production-grade infrastructure from day one</CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <div className="space-y-2">
              <Badge variant="secondary" className="bg-green-100 text-green-800">
                SOC 2 Compliant
              </Badge>
              <Badge variant="secondary" className="bg-green-100 text-green-800">
                99.9% SLA
              </Badge>
              <Badge variant="secondary" className="bg-green-100 text-green-800">
                24/7 Support
              </Badge>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 bg-gradient-to-br from-blue-50 to-background">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 p-3 bg-blue-600 rounded-full w-fit">
              <Clock className="w-8 h-8 text-white" />
            </div>
            <CardTitle className="font-serif text-xl">Rapid Deployment</CardTitle>
            <CardDescription>From configuration to production in minutes</CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <div className="space-y-2">
              <Badge variant="secondary" className="bg-blue-100 text-blue-800">
                5 Min Setup
              </Badge>
              <Badge variant="secondary" className="bg-blue-100 text-blue-800">
                Auto Scaling
              </Badge>
              <Badge variant="secondary" className="bg-blue-100 text-blue-800">
                Zero Downtime
              </Badge>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 bg-gradient-to-br from-purple-50 to-background">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 p-3 bg-purple-600 rounded-full w-fit">
              <Zap className="w-8 h-8 text-white" />
            </div>
            <CardTitle className="font-serif text-xl">AI-Powered</CardTitle>
            <CardDescription>Intelligent optimization and recommendations</CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <div className="space-y-2">
              <Badge variant="secondary" className="bg-purple-100 text-purple-800">
                Smart Config
              </Badge>
              <Badge variant="secondary" className="bg-purple-100 text-purple-800">
                Cost Optimization
              </Badge>
              <Badge variant="secondary" className="bg-purple-100 text-purple-800">
                Predictive Scaling
              </Badge>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
