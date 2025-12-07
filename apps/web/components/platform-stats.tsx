import { Card, CardContent } from "@/components/ui/card"

export function PlatformStats() {
  const stats = [
    { label: "Active Projects", value: "2,500+", color: "text-cyan-600" },
    { label: "Deployments", value: "50K+", color: "text-purple-600" },
    { label: "Uptime", value: "99.9%", color: "text-green-600" },
    { label: "Regions", value: "15+", color: "text-orange-600" },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-12">
      {stats.map((stat, index) => (
        <Card key={index} className="text-center border-0 bg-card/50 backdrop-blur-sm">
          <CardContent className="pt-6">
            <div className={`text-3xl font-bold ${stat.color} mb-2`}>{stat.value}</div>
            <div className="text-sm text-muted-foreground">{stat.label}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
