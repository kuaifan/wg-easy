ALTER TABLE `clients_table` ADD COLUMN `upstream` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `clients_table` ADD COLUMN `split_tunnel` text DEFAULT '' NOT NULL;
