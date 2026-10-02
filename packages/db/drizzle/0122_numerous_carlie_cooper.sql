CREATE TABLE `thread_provider_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`kind` text NOT NULL,
	`host_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`provider_thread_id` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`failure_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_provider_operations_pending_idx` ON `thread_provider_operations` (`thread_id`,`kind`) WHERE "thread_provider_operations"."status" = 'pending';