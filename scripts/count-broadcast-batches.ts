import "dotenv/config";
import { getDb, closeMongo } from "../src/services/mongo";

async function main() {
  const db = await getDb();
  const users = db.collection("users");
  const reminders = db.collection("reminder_preferences");

  const totalUsers = await users.countDocuments();

  const usersByStatus = await users
    .aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }])
    .toArray();

  const totalReminders = await reminders.countDocuments();
  const enabledReminders = await reminders.countDocuments({ enabled: true });

  // Distinct user_ids that have at least one reminder (any)
  const distinctAnyReminder = (await reminders.distinct("user_id")).length;
  // Distinct user_ids that have at least one ENABLED reminder
  const distinctEnabledReminder = (
    await reminders.distinct("user_id", { enabled: true })
  ).length;

  // How many of those reminder user_ids actually resolve to a real user doc,
  // counting users that have >=1 enabled reminder via the same matching logic
  // used by getAllActiveReminderSettings (handles string vs ObjectId).
  const usersWithEnabledReminder = await users
    .aggregate([
      {
        $lookup: {
          from: "reminder_preferences",
          let: { userOid: "$_id", userIdStr: "$id" },
          pipeline: [
            { $match: { enabled: true } },
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ["$user_id", "$$userIdStr"] },
                    { $eq: ["$user_id", { $toString: "$$userOid" }] },
                    {
                      $and: [
                        { $eq: [{ $type: "$user_id" }, "objectId"] },
                        { $eq: ["$user_id", "$$userOid"] },
                      ],
                    },
                  ],
                },
              },
            },
            { $limit: 1 },
          ],
          as: "r",
        },
      },
      { $match: { "r.0": { $exists: true } } },
      { $count: "total" },
    ])
    .toArray();

  const usersWithAnyReminder = await users
    .aggregate([
      {
        $lookup: {
          from: "reminder_preferences",
          let: { userOid: "$_id", userIdStr: "$id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ["$user_id", "$$userIdStr"] },
                    { $eq: ["$user_id", { $toString: "$$userOid" }] },
                    {
                      $and: [
                        { $eq: [{ $type: "$user_id" }, "objectId"] },
                        { $eq: ["$user_id", "$$userOid"] },
                      ],
                    },
                  ],
                },
              },
            },
            { $limit: 1 },
          ],
          as: "r",
        },
      },
      { $match: { "r.0": { $exists: true } } },
      { $count: "total" },
    ])
    .toArray();

  const withEnabled = (usersWithEnabledReminder[0] as any)?.total ?? 0;
  const withAny = (usersWithAnyReminder[0] as any)?.total ?? 0;

  console.log("================ BROADCAST BATCH COUNTS ================");
  console.log("Total users:                         ", totalUsers);
  console.log("Users by status:                     ", JSON.stringify(usersByStatus));
  console.log("-------------------------------------------------------");
  console.log("Total reminder docs:                 ", totalReminders);
  console.log("Enabled reminder docs:               ", enabledReminders);
  console.log("Distinct user_id w/ ANY reminder:    ", distinctAnyReminder);
  console.log("Distinct user_id w/ ENABLED reminder:", distinctEnabledReminder);
  console.log("-------------------------------------------------------");
  console.log("USERS matched w/ ANY reminder:       ", withAny, "(BATCH 1 if 'any')");
  console.log("USERS matched w/ ENABLED reminder:   ", withEnabled, "(BATCH 1 if 'active/enabled')");
  console.log("USERS w/o ANY reminder:              ", totalUsers - withAny, "(BATCH 2 if 'any')");
  console.log("USERS w/o ENABLED reminder:          ", totalUsers - withEnabled, "(BATCH 2 if 'active/enabled')");
  console.log("=======================================================");

  await closeMongo();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
