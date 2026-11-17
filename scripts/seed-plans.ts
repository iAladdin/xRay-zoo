import { db } from "../packages/core/db.js";
import { seedDefaultPlans } from "../packages/core/default-plans.js";
try {
  console.log(await seedDefaultPlans());
} finally {
  await db.$disconnect();
}
