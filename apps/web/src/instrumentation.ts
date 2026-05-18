import path from "path";

export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;

	// Guard before touching @/db — importing it triggers webEnv Zod validation,
	// which throws if DATABASE_URL is absent (e.g. during next build or cold
	// starts where env isn't injected yet).
	if (!process.env.DATABASE_URL) {
		console.warn("instrumentation: DATABASE_URL not set, skipping migrations");
		return;
	}

	const migrationsFolder =
		process.env.NODE_ENV === "production"
			? path.join(process.cwd(), "apps/web/migrations")
			: path.join(process.cwd(), "migrations");

	try {
		const { migrate } = await import("drizzle-orm/postgres-js/migrator");
		const { db } = await import("@/db");
		await migrate(db, { migrationsFolder });
	} catch (err) {
		console.error("Migration failed:", err);
	}
}
