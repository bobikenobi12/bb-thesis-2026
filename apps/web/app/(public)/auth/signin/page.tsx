import { SignInForm } from "@/components/forms/signin-form";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

export default function SignInPage() {
	return (
		<div className="min-h-screen bg-linear-to-br from-slate-50 via-white to-cyan-50/30">
			<div className="container mx-auto px-4 py-8">
				<Link
					href="/"
					className="inline-flex items-center gap-2 text-sm text-slate-600 hover:text-slate-900 transition-colors mb-8"
				>
					<ArrowLeft className="w-4 h-4" />
					Back to home
				</Link>

				<div className="max-w-md mx-auto mt-16">
					<div className="bg-white rounded-2xl shadow-xl border border-slate-200 p-8">
						<div className="text-center mb-8">
							<h1 className="text-3xl font-bold text-slate-900 mb-2">
								Welcome back
							</h1>
							<p className="text-slate-600">
								Sign in to your ItGix account
							</p>
						</div>

						<SignInForm />
					</div>

					<p className="text-center text-sm text-slate-600 mt-6">
						By signing in, you agree to our{" "}
						<Link
							href="/terms"
							className="text-cyan-600 hover:text-cyan-700"
						>
							Terms of Service
						</Link>{" "}
						and{" "}
						<Link
							href="/privacy"
							className="text-cyan-600 hover:text-cyan-700"
						>
							Privacy Policy
						</Link>
					</p>
				</div>
			</div>
		</div>
	);
}
