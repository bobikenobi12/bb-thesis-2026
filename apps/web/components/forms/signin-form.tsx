"use client";

import type React from "react";

import {
	signInWithMagicLink,
	signInWithOAuth,
} from "@/app/(public)/auth/signin/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Boxes, GitBranch, Github, Mail } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

type AuthProvider = "github" | "gitlab" | "bitbucket" | "google";

export function SignInForm() {
	const [isLoading, setIsLoading] = useState(false);
	const [email, setEmail] = useState("");
	const [emailSent, setEmailSent] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const router = useRouter();

	const handleMagicLinkLogin = async (e: React.FormEvent) => {
		e.preventDefault();
		setIsLoading(true);
		setError(null);

		try {
			const result = await signInWithMagicLink(email);

			if (result.success) {
				setEmailSent(true);
			}

			setEmailSent(true);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to send magic link"
			);
		} finally {
			setIsLoading(false);
		}
	};

	const handleOAuthLogin = async (provider: AuthProvider) => {
		setIsLoading(true);
		setError(null);

		try {
			await signInWithOAuth(provider);
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: `Failed to sign in with ${provider}`
			);
			setIsLoading(false);
		}
	};

	if (emailSent) {
		return (
			<div className="text-center space-y-4">
				<div className="w-16 h-16 bg-cyan-100 rounded-full flex items-center justify-center mx-auto">
					<Mail className="w-8 h-8 text-cyan-600" />
				</div>
				<div>
					<h3 className="text-xl font-semibold text-slate-900 mb-2">
						Check your email
					</h3>
					<p className="text-slate-600">
						We&rsquo;ve sent a magic link to{" "}
						<strong>{email}</strong>
					</p>
					<p className="text-sm text-slate-500 mt-2">
						Click the link in the email to sign in to your account
					</p>
				</div>
				<Button
					variant="outline"
					onClick={() => {
						setEmailSent(false);
						setEmail("");
					}}
					className="mt-4"
				>
					Use a different email
				</Button>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{error && (
				<div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg text-sm">
					{error}
				</div>
			)}

			{/* OAuth Providers */}
			<div className="space-y-3">
				<Button
					onClick={() => handleOAuthLogin("google")}
					disabled={isLoading}
					variant="outline"
					className="w-full h-12 text-base font-medium hover:bg-slate-50 transition-colors"
				>
					<Mail className="w-5 h-5 mr-3" />
					Continue with Google
				</Button>

				<Button
					onClick={() => handleOAuthLogin("github")}
					disabled={isLoading}
					variant="outline"
					className="w-full h-12 text-base font-medium hover:bg-slate-50 transition-colors"
				>
					<Github className="w-5 h-5 mr-3" />
					Continue with GitHub
				</Button>

				<Button
					onClick={() => handleOAuthLogin("gitlab")}
					disabled={isLoading}
					variant="outline"
					className="w-full h-12 text-base font-medium hover:bg-slate-50 transition-colors"
				>
					<GitBranch className="w-5 h-5 mr-3" />
					Continue with GitLab
				</Button>

				<Button
					onClick={() => handleOAuthLogin("bitbucket")}
					disabled={isLoading}
					variant="outline"
					className="w-full h-12 text-base font-medium hover:bg-slate-50 transition-colors"
				>
					<Boxes className="w-5 h-5 mr-3" />
					Continue with Bitbucket
				</Button>
			</div>

			<div className="relative">
				<div className="absolute inset-0 flex items-center">
					<Separator className="w-full" />
				</div>
				<div className="relative flex justify-center text-xs uppercase">
					<span className="bg-white px-2 text-slate-500">
						Or continue with email
					</span>
				</div>
			</div>

			{/* Magic Link Email Form */}
			<form onSubmit={handleMagicLinkLogin} className="space-y-4">
				<div className="space-y-2">
					<Label htmlFor="email">Email address</Label>
					<Input
						id="email"
						type="email"
						placeholder="name@company.com"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						required
						className="h-12"
						disabled={isLoading}
					/>
					<p className="text-xs text-slate-500">
						We&rsquo;ll send you a magic link to sign in
					</p>
				</div>

				<Button
					type="submit"
					disabled={isLoading || !email}
					className="w-full h-12 text-base font-medium bg-cyan-600 hover:bg-cyan-700 text-white"
				>
					{isLoading ? "Sending..." : "Send magic link"}
				</Button>
			</form>

			<div className="text-center">
				<p className="text-sm text-slate-600">
					New to ItGix?{" "}
					<button
						type="button"
						className="text-cyan-600 hover:text-cyan-700 font-medium"
						onClick={() => router.push("/contact")}
					>
						Contact sales
					</button>
				</p>
			</div>
		</div>
	);
}
