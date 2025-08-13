export type Json =
	| string
	| number
	| boolean
	| null
	| { [key: string]: Json | undefined }
	| Json[];

export interface Database {
	public: {
		Tables: {
			shared_videos: {
				Row: {
					shared_at: string;
					shared_by_user_id: string | null;
					space_id: string;
					video_id: string;
				};
				Insert: {
					shared_at?: string;
					shared_by_user_id?: string | null;
					space_id: string;
					video_id: string;
				};
				Update: {
					shared_at?: string;
					shared_by_user_id?: string | null;
					space_id?: string;
					video_id?: string;
				};
				Relationships: [
					{
						foreignKeyName: "shared_videos_shared_by_user_id_fkey";
						columns: ["shared_by_user_id"];
						isOneToOne: false;
						referencedRelation: "users";
						referencedColumns: ["id"];
					},
					{
						foreignKeyName: "shared_videos_space_id_fkey";
						columns: ["space_id"];
						isOneToOne: false;
						referencedRelation: "spaces";
						referencedColumns: ["id"];
					},
					{
						foreignKeyName: "shared_videos_video_id_fkey";
						columns: ["video_id"];
						isOneToOne: false;
						referencedRelation: "videos";
						referencedColumns: ["id"];
					},
				];
			};
			space_members: {
				Row: {
					role: Database["public"]["Enums"]["user_role"];
					space_id: string;
					user_id: string;
				};
				Insert: {
					role: Database["public"]["Enums"]["user_role"];
					space_id: string;
					user_id: string;
				};
				Update: {
					role?: Database["public"]["Enums"]["user_role"];
					space_id?: string;
					user_id?: string;
				};
				Relationships: [
					{
						foreignKeyName: "space_members_space_id_fkey";
						columns: ["space_id"];
						isOneToOne: false;
						referencedRelation: "spaces";
						referencedColumns: ["id"];
					},
					{
						foreignKeyName: "space_members_user_id_fkey";
						columns: ["user_id"];
						isOneToOne: false;
						referencedRelation: "users";
						referencedColumns: ["id"];
					},
				];
			};
			spaces: {
				Row: {
					created_at: string;
					id: string;
					metadata: Json | null;
					name: string;
					owner_id: string | null;
					updated_at: string;
				};
				Insert: {
					created_at?: string;
					id?: string;
					metadata?: Json | null;
					name: string;
					owner_id?: string | null;
					updated_at?: string;
				};
				Update: {
					created_at?: string;
					id?: string;
					metadata?: Json | null;
					name?: string;
					owner_id?: string | null;
					updated_at?: string;
				};
				Relationships: [
					{
						foreignKeyName: "spaces_owner_id_fkey";
						columns: ["owner_id"];
						isOneToOne: false;
						referencedRelation: "users";
						referencedColumns: ["id"];
					},
				];
			};
			users: {
				Row: {
					active_space_id: string | null;
					avatar_url: string | null;
					created_at: string;
					email: string;
					full_name: string | null;
					id: string;
					onboarding_questions: Json | null;
					stripe_customer_id: string | null;
					stripe_subscription_id: string | null;
					stripe_subscription_price_id: string | null;
					stripe_subscription_status: string | null;
					updated_at: string;
					video_quota: number;
					videos_created: number;
				};
				Insert: {
					active_space_id?: string | null;
					avatar_url?: string | null;
					created_at?: string;
					email: string;
					full_name?: string | null;
					id?: string;
					onboarding_questions?: Json | null;
					stripe_customer_id?: string | null;
					stripe_subscription_id?: string | null;
					stripe_subscription_price_id?: string | null;
					stripe_subscription_status?: string | null;
					updated_at?: string;
					video_quota?: number;
					videos_created?: number;
				};
				Update: {
					active_space_id?: string | null;
					avatar_url?: string | null;
					created_at?: string;
					email?: string;
					full_name?: string | null;
					id?: string;
					onboarding_questions?: Json | null;
					stripe_customer_id?: string | null;
					stripe_subscription_id?: string | null;
					stripe_subscription_price_id?: string | null;
					stripe_subscription_status?: string | null;
					updated_at?: string;
					video_quota?: number;
					videos_created?: number;
				};
				Relationships: [
					{
						foreignKeyName: "users_active_space_id_fkey";
						columns: ["active_space_id"];
						isOneToOne: false;
						referencedRelation: "spaces";
						referencedColumns: ["id"];
					},
				];
			};
			videos: {
				Row: {
					aws_bucket: string | null;
					aws_region: string | null;
					complete: boolean;
					created_at: string;
					duration: number | null;
					id: string;
					is_public: boolean;
					metadata: Json | null;
					name: string;
					owner_id: string | null;
					s3_url: string | null;
					thumbnail_url: string | null;
					updated_at: string;
				};
				Insert: {
					aws_bucket?: string | null;
					aws_region?: string | null;
					complete?: boolean;
					created_at?: string;
					duration?: number | null;
					id?: string;
					is_public?: boolean;
					metadata?: Json | null;
					name?: string;
					owner_id?: string | null;
					s3_url?: string | null;
					thumbnail_url?: string | null;
					updated_at?: string;
				};
				Update: {
					aws_bucket?: string | null;
					aws_region?: string | null;
					complete?: boolean;
					created_at?: string;
					duration?: number | null;
					id?: string;
					is_public?: boolean;
					metadata?: Json | null;
					name?: string;
					owner_id?: string | null;
					s3_url?: string | null;
					thumbnail_url?: string | null;
					updated_at?: string;
				};
				Relationships: [
					{
						foreignKeyName: "videos_owner_id_fkey";
						columns: ["owner_id"];
						isOneToOne: false;
						referencedRelation: "users";
						referencedColumns: ["id"];
					},
				];
			};
		};
		Views: {
			[_ in never]: never;
		};
		Functions: {
			citext:
				| {
						Args: {
							"": boolean;
						};
						Returns: string;
				  }
				| {
						Args: {
							"": string;
						};
						Returns: string;
				  }
				| {
						Args: {
							"": unknown;
						};
						Returns: string;
				  };
			citext_hash: {
				Args: {
					"": string;
				};
				Returns: number;
			};
			citextin: {
				Args: {
					"": unknown;
				};
				Returns: string;
			};
			citextout: {
				Args: {
					"": string;
				};
				Returns: unknown;
			};
			citextrecv: {
				Args: {
					"": unknown;
				};
				Returns: string;
			};
			citextsend: {
				Args: {
					"": string;
				};
				Returns: string;
			};
		};
		Enums: {
			user_role: "owner" | "admin" | "member";
		};
		CompositeTypes: {
			[_ in never]: never;
		};
	};
}

export type Tables<
	PublicTableNameOrOptions extends
		| keyof (Database["public"]["Tables"] & Database["public"]["Views"])
		| { schema: keyof Database },
	TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
		? keyof (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
				Database[PublicTableNameOrOptions["schema"]]["Views"])
		: never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
	? (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
			Database[PublicTableNameOrOptions["schema"]]["Views"])[TableName] extends {
			Row: infer R;
		}
		? R
		: never
	: PublicTableNameOrOptions extends keyof (Database["public"]["Tables"] &
				Database["public"]["Views"])
		? (Database["public"]["Tables"] &
				Database["public"]["Views"])[PublicTableNameOrOptions] extends {
				Row: infer R;
			}
			? R
			: never
		: never;

export type TablesInsert<
	PublicTableNameOrOptions extends
		| keyof Database["public"]["Tables"]
		| { schema: keyof Database },
	TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
		? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
		: never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
	? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
			Insert: infer I;
		}
		? I
		: never
	: PublicTableNameOrOptions extends keyof Database["public"]["Tables"]
		? Database["public"]["Tables"][PublicTableNameOrOptions] extends {
				Insert: infer I;
			}
			? I
			: never
		: never;

export type TablesUpdate<
	PublicTableNameOrOptions extends
		| keyof Database["public"]["Tables"]
		| { schema: keyof Database },
	TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
		? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
		: never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
	? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
			Update: infer U;
		}
		? U
		: never
	: PublicTableNameOrOptions extends keyof Database["public"]["Tables"]
		? Database["public"]["Tables"][PublicTableNameOrOptions] extends {
				Update: infer U;
			}
			? U
			: never
		: never;

export type Enums<
	PublicEnumNameOrOptions extends
		| keyof Database["public"]["Enums"]
		| { schema: keyof Database },
	EnumName extends PublicEnumNameOrOptions extends { schema: keyof Database }
		? keyof Database[PublicEnumNameOrOptions["schema"]]["Enums"]
		: never = never,
> = PublicEnumNameOrOptions extends { schema: keyof Database }
	? Database[PublicEnumNameOrOptions["schema"]]["Enums"][EnumName]
	: PublicEnumNameOrOptions extends keyof Database["public"]["Enums"]
		? Database["public"]["Enums"][PublicEnumNameOrOptions]
		: never;
