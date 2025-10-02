PRAGMA journal_mode=WAL;

--> statement-breakpoint
-- Create upstream_servers table
CREATE TABLE `upstream_servers` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  `name` TEXT NOT NULL,
  `interface_name` TEXT NOT NULL UNIQUE,
  `endpoint` TEXT NOT NULL,
  `public_key` TEXT NOT NULL,
  `private_key` TEXT NOT NULL,
  `preshared_key` TEXT,
  `allowed_ips` TEXT NOT NULL,
  `persistent_keepalive` INTEGER DEFAULT 25 NOT NULL,
  `mtu` INTEGER DEFAULT 1360 NOT NULL,
  `enabled` INTEGER DEFAULT 1 NOT NULL,
  `created_at` TEXT DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
  `updated_at` TEXT DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);

--> statement-breakpoint
-- Create split_rules table
CREATE TABLE `split_rules` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  `client_id` INTEGER NOT NULL,
  `rule_type` TEXT NOT NULL,
  `rule_value` TEXT NOT NULL,
  `action` TEXT DEFAULT 'proxy' NOT NULL,
  `enabled` INTEGER DEFAULT 1 NOT NULL,
  `created_at` TEXT DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
  `updated_at` TEXT DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
  FOREIGN KEY (`client_id`) REFERENCES `clients_table`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
);

--> statement-breakpoint
-- Create indexes for performance
CREATE INDEX `idx_split_rules_client_id` ON `split_rules`(`client_id`);
CREATE INDEX `idx_split_rules_enabled` ON `split_rules`(`enabled`);
CREATE INDEX `idx_split_rules_type` ON `split_rules`(`rule_type`);

--> statement-breakpoint
-- Extend clients_table with split tunneling fields
ALTER TABLE `clients_table` ADD COLUMN `upstream_enabled` INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE `clients_table` ADD COLUMN `upstream_id` INTEGER REFERENCES `upstream_servers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

--> statement-breakpoint
-- Create index for upstream relationship
CREATE INDEX `idx_clients_upstream_id` ON `clients_table`(`upstream_id`);
