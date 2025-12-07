"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { User as IUser } from "@supabase/supabase-js";
import {
	Bell,
	Folder,
	History,
	LayoutDashboard,
	LogOut,
	Menu,
	Plus,
	Search,
	Settings,
	User,
	X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type React from "react";
import { Suspense, useEffect, useState } from "react";

export default function DashboardLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const pathname = usePathname();
	const router = useRouter();
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [user, setUser] = useState<IUser | null>(null);

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
		router.push("/");
	};

	const navigation = [
		{ name: "Overview", href: "/dashboard", icon: LayoutDashboard },
		{ name: "New Configuration", href: "/dashboard/configure", icon: Plus },
		{
			name: "My Configurations",
			href: "/dashboard/configurations",
			icon: Folder,
		},
		{ name: "History", href: "/dashboard/history", icon: History },
	];

	const getUserInitials = () => {
		if (!user?.email) return "U";
		return user.email.substring(0, 2).toUpperCase();
	};

	return (
		<div className="h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50 overflow-y-hidden">
			{/* Header */}
			<header className="border-b bg-white/80 backdrop-blur-md sticky top-0 z-40 shadow-sm">
				<div className="px-6 py-4">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-4">
							<Button
								variant="ghost"
								size="icon"
								className="lg:hidden"
								onClick={() => setSidebarOpen(!sidebarOpen)}
							>
								{sidebarOpen ? (
									<X className="h-5 w-5" />
								) : (
									<Menu className="h-5 w-5" />
								)}
							</Button>
							<Link
								href="/dashboard"
								className="flex items-center gap-3"
							>
								<div className="w-9 h-9 bg-gradient-to-br from-cyan-600 to-purple-600 rounded-xl shadow-lg"></div>
								<div>
									<h2 className="font-sans text-lg font-bold text-slate-900">
										ItGix Platform
									</h2>
									<p className="text-xs text-slate-500">
										Application Development
									</p>
								</div>
							</Link>
						</div>

						<div className="flex items-center gap-3">
							{/* Search */}
							<div className="hidden md:flex items-center gap-2 bg-slate-100 rounded-lg px-3 py-2 w-64">
								<Search className="h-4 w-4 text-slate-400" />
								<Input
									placeholder="Search configurations..."
									className="border-0 bg-transparent p-0 h-auto focus-visible:ring-0 text-sm"
								/>
							</div>

							{/* Notifications */}
							<Button
								variant="ghost"
								size="icon"
								className="relative"
							>
								<Bell className="h-5 w-5" />
								<Badge className="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center p-0 bg-cyan-600">
									3
								</Badge>
							</Button>

							{/* User Menu */}
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
								<DropdownMenuContent
									className="w-56"
									align="end"
								>
									<DropdownMenuLabel>
										<div className="flex flex-col space-y-1">
											<p className="text-sm font-medium">
												My Account
											</p>
											<p className="text-xs text-muted-foreground truncate">
												{user?.email}
											</p>
										</div>
									</DropdownMenuLabel>
									<DropdownMenuSeparator />
									<DropdownMenuItem asChild>
										<Link
											href="/dashboard/profile"
											className="cursor-pointer"
										>
											<User className="mr-2 h-4 w-4" />
											Profile Settings
										</Link>
									</DropdownMenuItem>
									<DropdownMenuItem asChild>
										<Link
											href="/dashboard/configure"
											className="cursor-pointer"
										>
											<Settings className="mr-2 h-4 w-4" />
											New Configuration
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
					</div>
				</div>
			</header>

			<div className="flex">
				{/* Sidebar - Desktop */}
				<aside className="hidden lg:flex flex-col w-72 border-r bg-white h-[calc(100vh-73px)] sticky top-[73px]">
					{/* Navigation */}
					<nav className="flex-1 p-4 space-y-1">
						{navigation.map((item) => {
							const isActive = pathname === item.href;
							return (
								<Link key={item.name} href={item.href}>
									<Button
										variant={
											isActive ? "secondary" : "ghost"
										}
										className={cn(
											"w-full justify-start gap-3 h-11",
											isActive &&
												"bg-gradient-to-r from-cyan-50 to-purple-50 text-cyan-900 border border-cyan-200/50 shadow-sm"
										)}
									>
										<item.icon className="h-5 w-5" />
										<span className="font-medium">
											{item.name}
										</span>
									</Button>
								</Link>
							);
						})}
					</nav>

					<div className="p-4 border-t bg-slate-50/50">
						<Link href="/dashboard/profile">
							<div className="flex items-center gap-3 p-3 rounded-lg hover:bg-white transition-colors cursor-pointer group">
								<Avatar className="h-10 w-10 border-2 border-slate-200 group-hover:border-cyan-300 transition-colors">
									<AvatarImage
										src="/generic-user-avatar.png"
										alt="User"
									/>
									<AvatarFallback className="bg-gradient-to-br from-cyan-600 to-purple-600 text-white text-sm">
										{getUserInitials()}
									</AvatarFallback>
								</Avatar>
								<div className="flex-1 min-w-0">
									<p className="text-sm font-medium text-slate-900 truncate">
										{user?.user_metadata?.full_name ||
											"User"}
									</p>
									<p className="text-xs text-slate-500 truncate">
										{user?.email}
									</p>
								</div>
								<Settings className="h-4 w-4 text-slate-400 group-hover:text-cyan-600 transition-colors" />
							</div>
						</Link>
					</div>
				</aside>

				{/* Sidebar - Mobile */}
				{sidebarOpen && (
					<div
						className="lg:hidden fixed inset-0 z-50 bg-black/20 backdrop-blur-sm"
						onClick={() => setSidebarOpen(false)}
					>
						<aside
							className="fixed left-0 top-[73px] bottom-0 w-72 bg-white shadow-2xl flex flex-col"
							onClick={(e) => e.stopPropagation()}
						>
							<nav className="flex-1 p-4 space-y-1">
								{navigation.map((item) => {
									const isActive = pathname === item.href;
									return (
										<Link
											key={item.name}
											href={item.href}
											onClick={() =>
												setSidebarOpen(false)
											}
										>
											<Button
												variant={
													isActive
														? "secondary"
														: "ghost"
												}
												className={cn(
													"w-full justify-start gap-3 h-11",
													isActive &&
														"bg-gradient-to-r from-cyan-50 to-purple-50 text-cyan-900 border border-cyan-200/50"
												)}
											>
												<item.icon className="h-5 w-5" />
												<span className="font-medium">
													{item.name}
												</span>
											</Button>
										</Link>
									);
								})}
							</nav>

							{/* Profile section for mobile */}
							<div className="p-4 border-t bg-slate-50/50">
								<Link
									href="/dashboard/profile"
									onClick={() => setSidebarOpen(false)}
								>
									<div className="flex items-center gap-3 p-3 rounded-lg hover:bg-white transition-colors">
										<Avatar className="h-10 w-10 border-2 border-slate-200">
											<AvatarImage
												src="/generic-user-avatar.png"
												alt="User"
											/>
											<AvatarFallback className="bg-gradient-to-br from-cyan-600 to-purple-600 text-white text-sm">
												{getUserInitials()}
											</AvatarFallback>
										</Avatar>
										<div className="flex-1 min-w-0">
											<p className="text-sm font-medium text-slate-900 truncate">
												{user?.user_metadata
													?.full_name || "User"}
											</p>
											<p className="text-xs text-slate-500 truncate">
												{user?.email}
											</p>
										</div>
									</div>
								</Link>
							</div>
						</aside>
					</div>
				)}

				{/* Main Content */}
				<main className="flex-1 p-8 max-w-[1600px] h-[calc(100vh-73px)] overflow-y-scroll">
					<Suspense fallback={<div>Loading...</div>}>
						{children}
					</Suspense>
				</main>
			</div>
		</div>
	);
}
