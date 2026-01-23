"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { createClient } from "@/lib/supabase/client";
import { User as IUser } from "@supabase/supabase-js";
import {
	ArrowRight,
	Cloud,
	Database,
	GitBranch,
	Settings,
	Shield,
	Zap,
	User,
	LogOut,
	LayoutDashboard,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function HomePage() {
	const [user, setUser] = useState<IUser | null>(null);
	const router = useRouter();

	useEffect(() => {
		const getUser = async () => {
			const supabase = await createClient();
			const {
				data: { user },
			} = await supabase.auth.getUser();
			setUser(user);
		};
		getUser();
	}, []);

	const handleLogout = async () => {
		const supabase = await createClient();
		await supabase.auth.signOut();
		setUser(null);
		router.refresh();
	};

	const getUserInitials = () => {
		if (!user?.email) return "U";
		return user.email.substring(0, 2).toUpperCase();
	};

	return (
		<div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/20">
			{/* Header */}
			<header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
				<div className="container mx-auto px-4 py-4 flex items-center justify-between">
					<div className="flex items-center space-x-2">
						{/* <div className="w-8 h-8 bg-gradient-to-br from-cyan-500 to-purple-600 rounded-lg flex items-center justify-center">
							<span className="text-white font-bold text-sm">
								IG
							</span>
						</div> */}
						<img
							src="/itgix-favicon-32x32.png"
							alt="ItGix Logo"
							className="w-8 h-8"
						/>
						<span className="font-sans font-semibold text-xl">
							ItGix Grape
						</span>
					</div>
					
					{user ? (
						<div className="flex items-center gap-4">
							<Link href="/dashboard/configurations">
								<Button variant="outline" className="font-sans">
									Go to Configurations
									<ArrowRight className="ml-2 h-4 w-4" />
								</Button>
							</Link>
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										variant="ghost"
										className="relative h-10 w-10 rounded-full"
									>
										<Avatar className="h-10 w-10 border-2 border-cyan-200">
											<AvatarImage
												src="/generic-user-avatar.png"
												alt="User"
											/>
											<AvatarFallback className="bg-gradient-to-br from-cyan-600 to-purple-600 text-white">
												{getUserInitials()}
											</AvatarFallback>
										</Avatar>
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent className="w-56" align="end">
									<DropdownMenuLabel>
										<div className="flex flex-col space-y-1">
											<p className="text-sm font-medium">My Account</p>
											<p className="text-xs text-muted-foreground truncate">
												{user.email}
											</p>
										</div>
									</DropdownMenuLabel>
									<DropdownMenuSeparator />
									<DropdownMenuItem asChild>
										<Link href="/dashboard" className="cursor-pointer">
											<LayoutDashboard className="mr-2 h-4 w-4" />
											Dashboard
										</Link>
									</DropdownMenuItem>
									<DropdownMenuItem asChild>
										<Link href="/dashboard/profile" className="cursor-pointer">
											<User className="mr-2 h-4 w-4" />
											Profile Settings
										</Link>
									</DropdownMenuItem>
									<DropdownMenuSeparator />
									<DropdownMenuItem
										onClick={handleLogout}
										className="cursor-pointer text-red-600"
									>
										<LogOut className="mr-2 h-4 w-4" />
										Sign out
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					) : (
						<Link href="/auth/signin">
							<Button
								variant="outline"
								className="font-sans bg-transparent"
							>
								Sign In
								<ArrowRight className="ml-2 h-4 w-4" />
							</Button>
						</Link>
					)}
				</div>
			</header>

			{/* Hero Section */}
			<section className="container mx-auto px-4 py-20">
				<div className="max-w-4xl mx-auto text-center">
					<Badge variant="secondary" className="mb-6 font-sans">
						Enterprise Application Development Platform
					</Badge>
					<h1 className="font-sans font-bold text-5xl md:text-6xl text-foreground mb-6 leading-tight">
						Deploy AWS Infrastructure
						<span className="bg-gradient-to-r from-cyan-500 to-purple-600 bg-clip-text text-transparent block">
							In Minutes, Not Hours
						</span>
					</h1>
					<p className="text-muted-foreground text-xl mb-8 max-w-2xl mx-auto leading-relaxed">
						Streamline your cloud deployment workflow with our
						intelligent configuration platform. Generate
						production-ready Terraform, Kubernetes, and ArgoCD
						configurations with enterprise-grade security.
					</p>
					<div className="flex flex-col sm:flex-row gap-4 justify-center">
						<Link href={user ? "/dashboard" : "/auth/signin"}>
							<Button
								size="lg"
								className="font-sans text-lg px-8 py-6"
							>
								{user ? "Go to Dashboard" : "Get Started Free"}
								<ArrowRight className="ml-2 h-5 w-5" />
							</Button>
						</Link>
						<Link href="/installation">
							<Button
								variant="outline"
								size="lg"
								className="font-sans text-lg px-8 py-6 bg-transparent"
							>
								View Documentation
							</Button>
						</Link>
					</div>
				</div>
			</section>

			{/* Features Grid */}
			<section className="container mx-auto px-4 py-20">
				<div className="text-center mb-16">
					<h2 className="font-sans font-bold text-3xl md:text-4xl text-foreground mb-4">
						Everything You Need for Cloud Deployment
					</h2>
					<p className="text-muted-foreground text-lg max-w-2xl mx-auto">
						From infrastructure provisioning to application
						deployment, our platform handles the complexity so you
						can focus on building great products.
					</p>
				</div>

				<div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8 max-w-6xl mx-auto">
					<Card className="border-0 bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-all duration-300">
						<CardHeader>
							<div className="w-12 h-12 bg-gradient-to-br from-cyan-500 to-cyan-600 rounded-lg flex items-center justify-center mb-4">
								<Cloud className="h-6 w-6 text-white" />
							</div>
							<CardTitle className="font-sans text-xl">
								AWS Infrastructure
							</CardTitle>
							<CardDescription className="font-sans">
								Automated VPC, EKS, RDS, and CloudFront
								configuration with best practices built-in.
							</CardDescription>
						</CardHeader>
					</Card>

					<Card className="border-0 bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-all duration-300">
						<CardHeader>
							<div className="w-12 h-12 bg-gradient-to-br from-purple-500 to-purple-600 rounded-lg flex items-center justify-center mb-4">
								<GitBranch className="h-6 w-6 text-white" />
							</div>
							<CardTitle className="font-sans text-xl">
								GitOps Integration
							</CardTitle>
							<CardDescription className="font-sans">
								Seamless ArgoCD setup with automated repository
								management and deployment pipelines.
							</CardDescription>
						</CardHeader>
					</Card>

					<Card className="border-0 bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-all duration-300">
						<CardHeader>
							<div className="w-12 h-12 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-lg flex items-center justify-center mb-4">
								<Settings className="h-6 w-6 text-white" />
							</div>
							<CardTitle className="font-sans text-xl">
								Smart Configuration
							</CardTitle>
							<CardDescription className="font-sans">
								Intelligent form-based configuration that
								generates production-ready Terraform code.
							</CardDescription>
						</CardHeader>
					</Card>

					<Card className="border-0 bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-all duration-300">
						<CardHeader>
							<div className="w-12 h-12 bg-gradient-to-br from-orange-500 to-orange-600 rounded-lg flex items-center justify-center mb-4">
								<Shield className="h-6 w-6 text-white" />
							</div>
							<CardTitle className="font-sans text-xl">
								Enterprise Security
							</CardTitle>
							<CardDescription className="font-sans">
								Built-in security best practices, IAM policies,
								and compliance-ready configurations.
							</CardDescription>
						</CardHeader>
					</Card>

					<Card className="border-0 bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-all duration-300">
						<CardHeader>
							<div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-blue-600 rounded-lg flex items-center justify-center mb-4">
								<Database className="h-6 w-6 text-white" />
							</div>
							<CardTitle className="font-sans text-xl">
								Database Management
							</CardTitle>
							<CardDescription className="font-sans">
								Automated RDS setup with scaling, backups, and
								monitoring configurations.
							</CardDescription>
						</CardHeader>
					</Card>

					<Card className="border-0 bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-all duration-300">
						<CardHeader>
							<div className="w-12 h-12 bg-gradient-to-br from-indigo-500 to-indigo-600 rounded-lg flex items-center justify-center mb-4">
								<Zap className="h-6 w-6 text-white" />
							</div>
							<CardTitle className="font-sans text-xl">
								Auto-Scaling
							</CardTitle>
							<CardDescription className="font-sans">
								Karpenter integration for intelligent Kubernetes
								node scaling and cost optimization.
							</CardDescription>
						</CardHeader>
					</Card>
				</div>
			</section>

			{/* CTA Section */}
			<section className="container mx-auto px-4 py-20">
				<div className="max-w-4xl mx-auto text-center">
					<div className="bg-gradient-to-r from-cyan-500/10 to-purple-600/10 rounded-2xl p-12 border border-cyan-500/20">
						<h2 className="font-sans font-bold text-3xl md:text-4xl text-foreground mb-4">
							Ready to Transform Your Deployment Process?
						</h2>
						<p className="text-muted-foreground text-lg mb-8 max-w-2xl mx-auto">
							Join enterprise teams who have reduced their
							infrastructure deployment time by 90% with our
							intelligent configuration platform.
						</p>
						<Link href="/auth/signin">
							<Button
								size="lg"
								className="font-sans text-lg px-8 py-6"
							>
								Start Building Now
								<ArrowRight className="ml-2 h-5 w-5" />
							</Button>
						</Link>
					</div>
				</div>
			</section>

			{/* Footer */}
			<footer className="border-t bg-muted/30">
				<div className="container mx-auto px-4 py-8">
					<div className="flex flex-col md:flex-row items-center justify-between">
						<div className="flex items-center space-x-2 mb-4 md:mb-0">
							<img
								src="/itgix-favicon-32x32.png"
								alt="ItGix Logo"
								className="w-6 h-6"
							/>
							<span className="font-sans font-semibold">
								ItGix Grape
							</span>
						</div>
						<p className="text-muted-foreground text-sm font-sans">
							© 2024 ItGix. Enterprise Application Development
							Platform.
						</p>
					</div>
				</div>
			</footer>
		</div>
	);
}
