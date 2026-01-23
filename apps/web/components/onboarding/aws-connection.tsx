"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
    Form,
    FormControl,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from "@/components/ui/form";
import { 
    ExternalLink, 
    Copy, 
    CheckCircle2, 
    AlertCircle, 
    Loader2,
    ShieldCheck,
    Terminal,
    CloudIcon
} from "lucide-react";
import { toast } from "sonner";

// Zod schema for Role ARN validation
const awsRoleSchema = z.object({
    roleArn: z.string().superRefine((val, ctx) => {
        if (val.startsWith("arn:aws:cloudformation:")) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "You have pasted a CloudFormation Stack ARN. Please go to the 'Outputs' tab in the AWS Console and copy the 'RoleArn' instead.",
            });
            return;
        }
        
        const iamRoleRegex = /^arn:aws:iam::\d{12}:role\/[\w+=,.@-]+$/;
        if (!iamRoleRegex.test(val)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Invalid IAM Role ARN format. Example: arn:aws:iam::123456789012:role/GrapeProvisionerRole",
            });
        }
    })
});

type AwsRoleFormValues = z.infer<typeof awsRoleSchema>;

interface AwsConnectionProps {
	onComplete: (roleArn: string) => Promise<void>;
    externalId: string;
}

export function AwsConnection({ onComplete, externalId }: AwsConnectionProps) {
	const [isValidating, setIsValidating] = useState(false);
	const [method, setMethod] = useState<"cloudformation" | "terraform">("cloudformation");
    
    const grapeAwsAccountId = process.env.NEXT_PUBLIC_GRAPE_AWS_ACCOUNT_ID || "123456789012"; // Fallback for dev
    
    // CloudFormation Console Link (Generic)
    const cfnUrl = "https://console.aws.amazon.com/cloudformation/home#/stacks/create/template?stackName=Grape-Onboarding";

    const form = useForm<AwsRoleFormValues>({
        resolver: zodResolver(awsRoleSchema),
        defaultValues: {
            roleArn: "",
        },
        mode: "onChange",
    });

    const handleDownload = () => {
        const link = document.createElement("a");
        link.href = "/grape-bootstrap.yaml";
        link.download = "grape-bootstrap.yaml";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const copyToClipboard = (text: string, label: string) => {
        navigator.clipboard.writeText(text);
        toast.success(`${label} copied to clipboard`);
    };

	const onSubmit = async (data: AwsRoleFormValues) => {
		setIsValidating(true);
        try {
		    await onComplete(data.roleArn);
            toast.success("AWS Account connected successfully!");
        } catch (error) {
            console.error(error);
            toast.error("Failed to connect account. Please check the role ARN.");
            setIsValidating(false);
        }
	};

	return (
		<div className="max-w-3xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
			<div className="text-center space-y-2">
				<h2 className="text-3xl font-bold tracking-tight text-slate-900">
					Connect your AWS Account
				</h2>
				<p className="text-slate-500 text-lg max-w-xl mx-auto">
					Grape needs a cross-account role to provision and manage your infrastructure securely.
				</p>
			</div>

			<div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Method Selection */}
                <div className="md:col-span-1 space-y-4">
                    <button
                        onClick={() => setMethod("cloudformation")}
                        className={`w-full p-4 rounded-xl border-2 text-left transition-all duration-200 ${
                            method === "cloudformation" 
                            ? "border-cyan-500 bg-cyan-50/50 ring-2 ring-cyan-200" 
                            : "border-slate-200 bg-white hover:border-slate-300"
                        }`}
                        type="button"
                    >
                        <div className={`p-2 rounded-lg w-fit mb-3 ${method === "cloudformation" ? "bg-cyan-500 text-white" : "bg-slate-100 text-slate-500"}`}>
                            <CloudIcon className="w-5 h-5" />
                        </div>
                        <div className="font-bold text-slate-900">CloudFormation</div>
                        <div className="text-xs text-slate-500 mt-1">Recommended for quick setup via AWS Console.</div>
                    </button>

                    <button
                        onClick={() => setMethod("terraform")}
                        className={`w-full p-4 rounded-xl border-2 text-left transition-all duration-200 ${
                            method === "terraform" 
                            ? "border-purple-500 bg-purple-50/50 ring-2 ring-purple-200" 
                            : "border-slate-200 bg-white hover:border-slate-300"
                        }`}
                         type="button"
                    >
                        <div className={`p-2 rounded-lg w-fit mb-3 ${method === "terraform" ? "bg-purple-500 text-white" : "bg-slate-100 text-slate-500"}`}>
                            <Terminal className="w-5 h-5" />
                        </div>
                        <div className="font-bold text-slate-900">Terraform / IaC</div>
                        <div className="text-xs text-slate-500 mt-1">Best for teams using Infrastructure as Code.</div>
                    </button>
                </div>

                {/* Instructions */}
                <Card className="md:col-span-2 border-none shadow-xl bg-white/80 backdrop-blur-sm border border-slate-200">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <ShieldCheck className="w-5 h-5 text-green-600" />
                            Setup Instructions
                        </CardTitle>
                        <CardDescription>
                            Follow these steps to authorize Grape in your AWS account.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        {method === "cloudformation" ? (
                            <div className="space-y-6">
                                <div className="flex gap-4">
                                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-cyan-100 text-cyan-700 flex items-center justify-center font-bold">1</div>
                                    <div>
                                        <div className="font-semibold text-slate-900">Download & Launch</div>
                                        <p className="text-sm text-slate-500 mt-1 mb-3">
                                            Download the template, then upload it to the CloudFormation console ("Upload a template file").
                                        </p>
                                        <div className="flex gap-3">
                                            <Button 
                                                onClick={handleDownload}
                                                variant="outline"
                                                className="border-cyan-200 text-cyan-700 hover:bg-cyan-50"
                                                type="button"
                                            >
                                                <CloudIcon className="w-4 h-4 mr-2" />
                                                Download Template
                                            </Button>
                                            <Button 
                                                onClick={() => window.open(cfnUrl, "_blank")}
                                                className="bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-700 hover:to-cyan-600 shadow-md"
                                                type="button"
                                            >
                                                <ExternalLink className="w-4 h-4 mr-2" />
                                                Open Console
                                            </Button>
                                        </div>
                                        <div className="mt-3 p-3 bg-slate-50 rounded text-xs text-slate-600">
                                            <strong>Parameters:</strong> Use ExternalId: <code className="bg-white px-1 border rounded">{externalId}</code>
                                            <button 
                                                onClick={() => copyToClipboard(externalId, "External ID")}
                                                className="ml-2 hover:text-cyan-600 inline-flex items-center"
                                                type="button"
                                            >
                                                <Copy className="w-3 h-3" />
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                <div className="flex gap-4">
                                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-cyan-100 text-cyan-700 flex items-center justify-center font-bold">2</div>
                                    <div className="flex-1">
                                        <div className="font-semibold text-slate-900">Copy Role ARN</div>
                                        <p className="text-sm text-slate-500 mt-1">
                                            Once the stack is created, go to the <b>Outputs</b> tab and copy the <b>RoleArn</b>.
                                        </p>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-6">
                                <div className="flex gap-4">
                                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-purple-100 text-purple-700 flex items-center justify-center font-bold">1</div>
                                    <div className="flex-1 min-w-0">
                                        <div className="font-semibold text-slate-900">Apply Terraform Template</div>
                                        <p className="text-sm text-slate-500 mt-1">
                                            Use the following External ID in your Terraform variables:
                                        </p>
                                        <div className="mt-3 flex items-center gap-2 p-3 bg-slate-900 rounded-lg text-slate-100 font-mono text-xs overflow-hidden">
                                            <span className="truncate">{externalId}</span>
                                            <button 
                                                onClick={() => copyToClipboard(externalId, "External ID")}
                                                className="ml-auto p-1 hover:bg-slate-700 rounded transition-colors"
                                                type="button"
                                            >
                                                <Copy className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                <div className="flex gap-4">
                                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-purple-100 text-purple-700 flex items-center justify-center font-bold">2</div>
                                    <div className="flex-1">
                                        <div className="font-semibold text-slate-900">Deploy & Extract ARN</div>
                                        <p className="text-sm text-slate-500 mt-1">
                                            Run <code className="bg-slate-100 px-1 rounded">terraform apply</code> and copy the output <b>role_arn</b>.
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}

                        <div className="pt-6 border-t border-slate-100">
                             <Form {...form}>
                                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                                    <FormField
                                        control={form.control}
                                        name="roleArn"
                                        render={({ field }) => (
                                            <FormItem>
                                                <FormLabel className="text-slate-900 font-semibold mb-2 block">
                                                    IAM Role ARN
                                                </FormLabel>
                                                <div className="flex gap-2 items-start">
                                                    <div className="relative flex-1">
                                                        <FormControl>
                                                            <Input 
                                                                placeholder="arn:aws:iam::123456789012:role/GrapeProvisionerRole"
                                                                className="bg-white border-slate-200 focus:border-cyan-500 focus:ring-cyan-200"
                                                                {...field}
                                                            />
                                                        </FormControl>
                                                        {!form.formState.errors.roleArn && field.value && field.value.startsWith("arn:aws:iam::") && (
                                                            <CheckCircle2 className="absolute right-3 top-2.5 h-5 w-5 text-green-500" />
                                                        )}
                                                    </div>
                                                    <Button 
                                                        disabled={!form.formState.isValid || isValidating}
                                                        type="submit"
                                                        className="bg-slate-900 hover:bg-slate-800 text-white min-w-[100px] mt-0"
                                                    >
                                                        {isValidating ? (
                                                            <Loader2 className="w-4 h-4 animate-spin" />
                                                        ) : (
                                                            "Connect"
                                                        )}
                                                    </Button>
                                                </div>
                                                <FormMessage />
                                            </FormItem>
                                        )}
                                    />
                                </form>
                            </Form>
                            
                            <div className="mt-4 flex items-start gap-2 p-3 bg-blue-50 rounded-lg border border-blue-100 text-blue-800 text-xs">
                                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                                <p>
                                    Security Check: Grape will verify it can assume this role using the unique External ID provided. 
                                    This prevents unauthorized cross-account access.
                                </p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>
		</div>
	);
}