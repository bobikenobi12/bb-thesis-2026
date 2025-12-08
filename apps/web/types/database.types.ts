export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      cli_logins: {
        Row: {
          created_at: string | null
          device_code: string
          expires_at: string | null
          profile_id: string | null
          refresh_token: string | null
          verification_code: string | null
        }
        Insert: {
          created_at?: string | null
          device_code: string
          expires_at?: string | null
          profile_id?: string | null
          refresh_token?: string | null
          verification_code?: string | null
        }
        Update: {
          created_at?: string | null
          device_code?: string
          expires_at?: string | null
          profile_id?: string | null
          refresh_token?: string | null
          verification_code?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cli_logins_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      configurations: {
        Row: {
          aws_account_id: string
          aws_region: string
          container_platform: string
          create_vpc: boolean | null
          created_at: string | null
          db_max_capacity: number | null
          db_min_capacity: number | null
          description: string | null
          dns_domain_name: string | null
          dns_hosted_zone: string | null
          download_count: number | null
          eks_cluster_admins: string | null
          enable_cloudfront_waf: boolean | null
          enable_dns: boolean | null
          enable_gitops_destination: boolean | null
          enable_karpenter: boolean | null
          enable_redis: boolean | null
          environment_repository: string | null
          environment_stage: string
          full_config: Json | null
          gitops_app_template: string | null
          gitops_app_token: string | null
          gitops_argocd_token: string | null
          gitops_destinations_repo: string | null
          gitops_repository: string | null
          id: string
          last_downloaded_at: string | null
          project_name: string
          redis_allowed_cidr_blocks: string | null
          ses_queues_topics: string | null
          status: string | null
          terraform_version: string
          updated_at: string | null
          user_id: string
          vpc_cidr: string | null
        }
        Insert: {
          aws_account_id: string
          aws_region: string
          container_platform: string
          create_vpc?: boolean | null
          created_at?: string | null
          db_max_capacity?: number | null
          db_min_capacity?: number | null
          description?: string | null
          dns_domain_name?: string | null
          dns_hosted_zone?: string | null
          download_count?: number | null
          eks_cluster_admins?: string | null
          enable_cloudfront_waf?: boolean | null
          enable_dns?: boolean | null
          enable_gitops_destination?: boolean | null
          enable_karpenter?: boolean | null
          enable_redis?: boolean | null
          environment_repository?: string | null
          environment_stage: string
          full_config?: Json | null
          gitops_app_template?: string | null
          gitops_app_token?: string | null
          gitops_argocd_token?: string | null
          gitops_destinations_repo?: string | null
          gitops_repository?: string | null
          id?: string
          last_downloaded_at?: string | null
          project_name: string
          redis_allowed_cidr_blocks?: string | null
          ses_queues_topics?: string | null
          status?: string | null
          terraform_version: string
          updated_at?: string | null
          user_id: string
          vpc_cidr?: string | null
        }
        Update: {
          aws_account_id?: string
          aws_region?: string
          container_platform?: string
          create_vpc?: boolean | null
          created_at?: string | null
          db_max_capacity?: number | null
          db_min_capacity?: number | null
          description?: string | null
          dns_domain_name?: string | null
          dns_hosted_zone?: string | null
          download_count?: number | null
          eks_cluster_admins?: string | null
          enable_cloudfront_waf?: boolean | null
          enable_dns?: boolean | null
          enable_gitops_destination?: boolean | null
          enable_karpenter?: boolean | null
          enable_redis?: boolean | null
          environment_repository?: string | null
          environment_stage?: string
          full_config?: Json | null
          gitops_app_template?: string | null
          gitops_app_token?: string | null
          gitops_argocd_token?: string | null
          gitops_destinations_repo?: string | null
          gitops_repository?: string | null
          id?: string
          last_downloaded_at?: string | null
          project_name?: string
          redis_allowed_cidr_blocks?: string | null
          ses_queues_topics?: string | null
          status?: string | null
          terraform_version?: string
          updated_at?: string | null
          user_id?: string
          vpc_cidr?: string | null
        }
        Relationships: []
      }
      deployment_logs: {
        Row: {
          created_at: string | null
          deployment_id: string
          id: string
          level: Database["public"]["Enums"]["logs_level"]
          message: string
          step: string | null
        }
        Insert: {
          created_at?: string | null
          deployment_id: string
          id?: string
          level: Database["public"]["Enums"]["logs_level"]
          message: string
          step?: string | null
        }
        Update: {
          created_at?: string | null
          deployment_id?: string
          id?: string
          level?: Database["public"]["Enums"]["logs_level"]
          message?: string
          step?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deployment_logs_deployment_id_fkey"
            columns: ["deployment_id"]
            isOneToOne: false
            referencedRelation: "deployments"
            referencedColumns: ["id"]
          },
        ]
      }
      deployment_resources: {
        Row: {
          aws_arn: string | null
          created_at: string | null
          deployment_id: string
          id: string
          properties: Json | null
          resource_id: string | null
          resource_name: string
          resource_type: string
          status: Database["public"]["Enums"]["deployment_resource_status"]
          updated_at: string | null
        }
        Insert: {
          aws_arn?: string | null
          created_at?: string | null
          deployment_id: string
          id?: string
          properties?: Json | null
          resource_id?: string | null
          resource_name: string
          resource_type: string
          status?: Database["public"]["Enums"]["deployment_resource_status"]
          updated_at?: string | null
        }
        Update: {
          aws_arn?: string | null
          created_at?: string | null
          deployment_id?: string
          id?: string
          properties?: Json | null
          resource_id?: string | null
          resource_name?: string
          resource_type?: string
          status?: Database["public"]["Enums"]["deployment_resource_status"]
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deployment_resources_deployment_id_fkey"
            columns: ["deployment_id"]
            isOneToOne: false
            referencedRelation: "deployments"
            referencedColumns: ["id"]
          },
        ]
      }
      deployments: {
        Row: {
          aws_region: string | null
          completed_at: string | null
          completed_steps: number | null
          configuration_id: string | null
          created_at: string | null
          current_step: string | null
          description: string | null
          duration_seconds: number | null
          error_message: string | null
          iac_tool: Database["public"]["Enums"]["iac_tool"]
          id: string
          lock_id: string | null
          logs: string | null
          name: string
          outputs: Json | null
          profile_id: string
          progress_percentage: number | null
          pulumi_version: string | null
          started_at: string | null
          state_bucket: string | null
          state_key: string | null
          status: Database["public"]["Enums"]["deployment_status"]
          terraform_version: string | null
          total_steps: number | null
          updated_at: string | null
        }
        Insert: {
          aws_region?: string | null
          completed_at?: string | null
          completed_steps?: number | null
          configuration_id?: string | null
          created_at?: string | null
          current_step?: string | null
          description?: string | null
          duration_seconds?: number | null
          error_message?: string | null
          iac_tool: Database["public"]["Enums"]["iac_tool"]
          id?: string
          lock_id?: string | null
          logs?: string | null
          name: string
          outputs?: Json | null
          profile_id: string
          progress_percentage?: number | null
          pulumi_version?: string | null
          started_at?: string | null
          state_bucket?: string | null
          state_key?: string | null
          status?: Database["public"]["Enums"]["deployment_status"]
          terraform_version?: string | null
          total_steps?: number | null
          updated_at?: string | null
        }
        Update: {
          aws_region?: string | null
          completed_at?: string | null
          completed_steps?: number | null
          configuration_id?: string | null
          created_at?: string | null
          current_step?: string | null
          description?: string | null
          duration_seconds?: number | null
          error_message?: string | null
          iac_tool?: Database["public"]["Enums"]["iac_tool"]
          id?: string
          lock_id?: string | null
          logs?: string | null
          name?: string
          outputs?: Json | null
          profile_id?: string
          progress_percentage?: number | null
          pulumi_version?: string | null
          started_at?: string | null
          state_bucket?: string | null
          state_key?: string | null
          status?: Database["public"]["Enums"]["deployment_status"]
          terraform_version?: string | null
          total_steps?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deployments_configuration_id_fkey"
            columns: ["configuration_id"]
            isOneToOne: false
            referencedRelation: "configurations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deployments_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string | null
          full_name: string | null
          id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      deployment_resource_status:
        | "creating"
        | "created"
        | "updating"
        | "deleting"
        | "deleted"
        | "failed"
      deployment_status:
        | "pending"
        | "initializing"
        | "planning"
        | "applying"
        | "completed"
        | "failed"
        | "cancelled"
        | "destroying"
      iac_tool: "pulumi" | "terraform"
      logs_level: "debug" | "info" | "warn" | "error" | "critical"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      deployment_resource_status: [
        "creating",
        "created",
        "updating",
        "deleting",
        "deleted",
        "failed",
      ],
      deployment_status: [
        "pending",
        "initializing",
        "planning",
        "applying",
        "completed",
        "failed",
        "cancelled",
        "destroying",
      ],
      iac_tool: ["pulumi", "terraform"],
      logs_level: ["debug", "info", "warn", "error", "critical"],
    },
  },
} as const
