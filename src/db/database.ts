import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export type AppDatabase = Database.Database;

export const createDatabase = (databasePath = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "forms.sqlite")): AppDatabase => {
	if (databasePath !== ":memory:") {
		fs.mkdirSync(path.dirname(databasePath), { recursive: true });
	}

	const db = new Database(databasePath);
	db.pragma("foreign_keys = ON");
	migrate(db);
	return db;
};

const migrate = (db: AppDatabase) => {
	db.exec(`
		CREATE TABLE IF NOT EXISTS ingested_forms (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT UNIQUE,
			application_reference TEXT UNIQUE,
			payload_hash TEXT NOT NULL UNIQUE,
			raw_payload TEXT NOT NULL,
			status TEXT NOT NULL,
			error_code TEXT,
			error_message TEXT,
			error_details TEXT,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);

		CREATE TABLE IF NOT EXISTS transformed_forms (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ingested_form_id INTEGER NOT NULL UNIQUE,
			session_id TEXT NOT NULL UNIQUE,
			application_reference TEXT NOT NULL UNIQUE,
			payload TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (ingested_form_id) REFERENCES ingested_forms(id)
		);

		CREATE TABLE IF NOT EXISTS email_notifications (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ingested_form_id INTEGER NOT NULL UNIQUE,
			to_address TEXT NOT NULL,
			status TEXT NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			last_error TEXT,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (ingested_form_id) REFERENCES ingested_forms(id)
		);
	`);

	const columns = db.prepare("PRAGMA table_info(ingested_forms)").all() as { name: string }[];
	if (!columns.some((column) => column.name === "error_details")) {
		db.exec("ALTER TABLE ingested_forms ADD COLUMN error_details TEXT");
	}
};
