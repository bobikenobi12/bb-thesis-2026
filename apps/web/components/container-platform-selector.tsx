"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { CheckCircle, Cpu, Zap, Settings } from "lucide-react"

interface ContainerPlatformSelectorProps {
  selected: string
  onSelect: (platform: string) => void
}

export function ContainerPlatformSelector({ selected, onSelect }: ContainerPlatformSelectorProps) {
  const platforms = [
    {
      id: "standard",
      title: "Standard",
      description: "General purpose workloads with balanced compute and memory",
      icon: <Cpu className="w-6 h-6" />,
      features: ["General workloads", "Balanced resources", "Cost optimized", "Quick setup"],
      color: "border-blue-200 bg-blue-50",
      iconColor: "bg-blue-600",
      recommended: false,
    },
    {
      id: "ai-workloads",
      title: "AI Workloads Ready",
      description: "Optimized for machine learning and AI applications",
      icon: <Zap className="w-6 h-6" />,
      features: ["GPU support", "ML frameworks", "High memory", "Specialized instances"],
      color: "border-purple-200 bg-purple-50",
      iconColor: "bg-purple-600",
      recommended: true,
    },
    {
      id: "custom",
      title: "Custom Template",
      description: "Fully customizable configuration for specific requirements",
      icon: <Settings className="w-6 h-6" />,
      features: ["Full customization", "Advanced options", "Expert mode", "Flexible scaling"],
      color: "border-green-200 bg-green-50",
      iconColor: "bg-green-600",
      recommended: false,
    },
  ]

  return (
    <div className="grid md:grid-cols-3 gap-4">
      {platforms.map((platform) => (
        <Card
          key={platform.id}
          className={`cursor-pointer transition-all duration-300 hover:shadow-lg ${
            selected === platform.id ? "ring-2 ring-cyan-500 border-cyan-500" : `border-2 ${platform.color}`
          }`}
          onClick={() => onSelect(platform.id)}
        >
          <CardHeader className="text-center">
            {platform.recommended && (
              <Badge className="mb-2 bg-gradient-to-r from-cyan-600 to-purple-600 text-white">Recommended</Badge>
            )}
            <div className={`mx-auto mb-3 p-3 ${platform.iconColor} rounded-xl w-fit`}>
              <div className="text-white">{platform.icon}</div>
            </div>
            <CardTitle className="font-serif text-lg">{platform.title}</CardTitle>
            <CardDescription className="text-sm">{platform.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {platform.features.map((feature, index) => (
                <li key={index} className="flex items-center gap-2 text-sm">
                  <CheckCircle className="w-4 h-4 text-green-600" />
                  {feature}
                </li>
              ))}
            </ul>
            {selected === platform.id && (
              <div className="mt-4 p-2 bg-cyan-100 rounded-lg text-center">
                <span className="text-sm font-medium text-cyan-800">Selected</span>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
