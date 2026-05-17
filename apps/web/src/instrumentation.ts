import path from "path";

export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		const { migrate } = await import("drizzle-orm/postgres-js/migrator");
		const { db } = await import("@/db");

		const migrationsFolder =
			process.env.NODE_ENV === "production"
				? path.join(process.cwd(), "apps/web/migrations")
				: path.join(process.cwd(), "migrations");

		try {
			await migrate(db, { migrationsFolder });
		} catch (err) {
			console.error("Migration failed:", err);
		}
	}
}
