import { MongoClient, Db, Collection, ObjectId } from "mongodb";
import { config } from "../config";
import { User, ReminderSetting } from "../types";
import logger from "../utils/logger";

let client: MongoClient | null = null;
let db: Db | null = null;

async function getDb(): Promise<Db> {
  if (db) return db;

  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      throw new Error("MONGODB_URI is not set in environment variables");
    }

    client = new MongoClient(uri);
    await client.connect();

    // Use a specific DB name; if none in URI, fallback to wa_bot
    const dbNameFromUri = new URL(uri).pathname.replace("/", "") || "wa_bot";
    db = client.db(dbNameFromUri);

    logger.info(`Connected to MongoDB database: ${db.databaseName}`);

    return db;
  } catch (error) {
    logger.error("Error connecting to MongoDB:", error);
    throw error;
  }
}

async function getUsersCollection(): Promise<Collection<User>> {
  const database = await getDb();
  return database.collection<User>("users");
}

async function getReminderPreferencesCollection(): Promise<
  Collection<ReminderSetting & { user_phone_number?: string; enabled?: boolean }>
> {
  const database = await getDb();
  return database.collection<
    ReminderSetting & { user_phone_number?: string; enabled?: boolean }
  >("reminder_preferences");
}

export class MongoService {
  // User cache: phoneNumber -> { user: User, timestamp: number }
  private userCache = new Map<string, { user: User; timestamp: number }>();
  private readonly USER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  /**
   * Clears user cache for a specific phone number
   */
  private clearUserCache(phoneNumber: string): void {
    this.userCache.delete(phoneNumber);
  }

  /**
   * Gets cached user if available and not expired
   */
  private getCachedUser(phoneNumber: string): User | null {
    const cached = this.userCache.get(phoneNumber);
    if (cached && Date.now() - cached.timestamp < this.USER_CACHE_TTL) {
      logger.debug(`User cache hit for ${phoneNumber}`);
      return cached.user;
    }
    if (cached) {
      this.userCache.delete(phoneNumber); // Expired, remove it
    }
    return null;
  }

  // User operations
  async getUserByPhone(phoneNumber: string): Promise<User | null> {
    try {
      // Check cache first
      const cached = this.getCachedUser(phoneNumber);
      if (cached) {
        return cached;
      }

      // Cache miss - fetch from DB
      const users = await getUsersCollection();
      const result = await users.findOne({ phone_number: phoneNumber });
      if (!result) return null;

      // Normalize Mongo document → User shape with string `id`
      const u: any = result;
      const user: User = {
        ...u,
        id: u.id || u._id?.toString(),
      };

      // Store in cache
      this.userCache.set(phoneNumber, {
        user,
        timestamp: Date.now(),
      });

      return user;
    } catch (error) {
      logger.error("Error fetching user by phone (Mongo):", error);
      throw error;
    }
  }

  async createUser(
    user: Omit<User, "id" | "created_at" | "updated_at">
  ): Promise<User> {
    try {
      const users = await getUsersCollection();
      const now = new Date().toISOString();
      const doc: User = {
        ...user,
        created_at: now,
        updated_at: now,
      };
      const result = await users.insertOne(doc as any);
      const createdUser: User = {
        ...doc,
        id: result.insertedId.toString(),
      };

      // Update cache with new user
      this.userCache.set(user.phone_number, {
        user: createdUser,
        timestamp: Date.now(),
      });

      return createdUser;
    } catch (error) {
      logger.error("Error creating user (Mongo):", error);
      throw error;
    }
  }

  async updateUser(
    phoneNumber: string,
    updates: Partial<User>
  ): Promise<User> {
    try {
      const users = await getUsersCollection();
      const now = new Date().toISOString();
      const result = await users.findOneAndUpdate(
        { phone_number: phoneNumber },
        {
          $set: {
            ...updates,
            updated_at: now,
          },
        },
        { returnDocument: "after" }
      );

      const value: any = (result as any).value ?? result;
      if (!value) {
        throw new Error(
          `User with phone_number ${phoneNumber} not found for update`
        );
      }

      const user = value as User & { _id?: any };
      const updatedUser: User = {
        ...user,
        id: user.id || user._id?.toString(),
      };

      // Update cache with updated user
      this.userCache.set(phoneNumber, {
        user: updatedUser,
        timestamp: Date.now(),
      });

      return updatedUser;
    } catch (error) {
      logger.error("Error updating user (Mongo):", error);
      throw error;
    }
  }

  async getAllActiveUsers(): Promise<User[]> {
    try {
      const users = await getUsersCollection();
      const result = await users.find({ status: "active" }).toArray();
      return result.map((u: any) => ({
        ...u,
        id: u.id || u._id?.toString(),
      }));
    } catch (error) {
      logger.error("Error fetching active users (Mongo):", error);
      throw error;
    }
  }

  // Reminder settings operations
  async getReminderSettings(userId: string): Promise<ReminderSetting[]> {
    try {
      const reminders = await getReminderPreferencesCollection();
      const result = await reminders.find({ user_id: userId }).toArray();
      return result.map((r: any) => ({
        ...r,
        id: r.id || r._id?.toString(),
      }));
    } catch (error) {
      logger.error("Error fetching reminder settings (Mongo):", error);
      throw error;
    }
  }

  async getReminderSetting(
    userId: string,
    reminderType: string
  ): Promise<ReminderSetting | null> {
    try {
      const reminders = await getReminderPreferencesCollection();
      const result = await reminders.findOne({
        user_id: userId,
        reminder_type: reminderType as any,
      });
      if (!result) return null;

      const r: any = result;
      return {
        ...r,
        id: r.id || r._id?.toString(),
      };
    } catch (error) {
      logger.error("Error fetching reminder setting (Mongo):", error);
      throw error;
    }
  }

  async upsertReminderSetting(
    setting: Omit<ReminderSetting, "id" | "created_at" | "updated_at">
  ): Promise<ReminderSetting> {
    try {
      const reminders = await getReminderPreferencesCollection();
      const now = new Date().toISOString();

      const filter = {
        user_id: setting.user_id,
        reminder_type: setting.reminder_type,
      };

      const update = {
        $set: {
          ...setting,
          updated_at: now,
        },
        $setOnInsert: {
          created_at: now,
        },
      };

      const result = await reminders.findOneAndUpdate(filter, update, {
        upsert: true,
        returnDocument: "after",
      });

      const value: any = (result as any).value ?? result;
      if (!value) {
        // In rare cases, value can be null with upsert; fetch again
        const fetched = await reminders.findOne(filter);
        if (!fetched) {
          throw new Error("Failed to upsert reminder setting");
        }
        const r: any = fetched;
        return {
          ...r,
          id: r.id || r._id?.toString(),
        };
      }

      return {
        ...value,
        id: value.id || value._id?.toString(),
      };
    } catch (error) {
      logger.error("Error upserting reminder setting (Mongo):", error);
      throw error;
    }
  }

  /**
   * Updates an existing reminder setting by ID
   * Used for editing reminders (updates offsetMinutes while keeping reminder_type)
   */
  async updateReminderSettingById(
    reminderId: string,
    updates: Partial<
      Omit<ReminderSetting, "id" | "created_at" | "user_id" | "reminder_type">
    >
  ): Promise<ReminderSetting | null> {
    try {
      const reminders = await getReminderPreferencesCollection();
      const now = new Date().toISOString();

      // Find by _id (MongoDB ObjectId) or custom `id` field
      let filter: any;
      if (ObjectId.isValid(reminderId)) {
        filter = {
          $or: [{ _id: new ObjectId(reminderId) }, { id: reminderId }],
        };
      } else {
        filter = { id: reminderId };
      }

      const update = {
        $set: {
          ...updates,
          updated_at: now,
        },
      };

      const result = await reminders.findOneAndUpdate(filter, update, {
        returnDocument: "after",
      });

      if (!result) {
        return null;
      }

      // Depending on driver version, result may be the document itself
      // or an object with a `.value` property.
      const value: any =
        (result as any).value !== undefined ? (result as any).value : result;

      return {
        ...value,
        id: value.id || value._id?.toString(),
      };
    } catch (error) {
      logger.error("Error updating reminder setting by ID (Mongo):", error);
      throw error;
    }
  }

  async getAllActiveReminderSettings(): Promise<
    (ReminderSetting & { users: User })[]
  > {
    try {
      const reminders = await getReminderPreferencesCollection();
      const users = await getUsersCollection();

      const pipeline = [
        { $match: { enabled: true } },
        {
          $lookup: {
            from: "users",
            let: { reminderUserId: "$user_id" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $or: [
                      // Match _id as ObjectId (convert string user_id to ObjectId)
                      {
                        $eq: [
                          "$_id",
                          {
                            $cond: {
                              if: {
                                $and: [
                                  { $eq: [{ $type: "$$reminderUserId" }, "string"] },
                                  { $eq: [{ $strLenCP: "$$reminderUserId" }, 24] },
                                ],
                              },
                              then: { $toObjectId: "$$reminderUserId" },
                              else: "$$reminderUserId",
                            },
                          },
                        ],
                      },
                      // Also try matching id field (if it exists as string)
                      { $eq: ["$id", "$$reminderUserId"] },
                    ],
                  },
                },
              },
            ],
            as: "users",
          },
        },
        { $unwind: "$users" },
        { $match: { "users.status": "active" } },
      ];

      logger.info(`🧪 TEST MODE: Executing MongoDB aggregation pipeline for active reminders`);
      const result = await reminders.aggregate(pipeline).toArray();
      logger.info(`🧪 TEST MODE: MongoDB query returned ${result.length} result(s)`);
      
      // Log details about what was found
      if (result.length > 0) {
        result.forEach((doc: any) => {
          logger.info(
            `🧪 TEST MODE: Found reminder ${doc._id} (${doc.reminder_type}) ` +
            `for user ${doc.users?.phone_number || 'unknown'}, ` +
            `test_time: ${doc.test_time || 'none'}, enabled: ${doc.enabled}`
          );
        });
      } else {
        // Debug: Check if there are any reminders at all
        const allReminders = await reminders.find({}).toArray();
        logger.info(`🧪 TEST MODE: Total reminders in DB: ${allReminders.length}`);
        if (allReminders.length > 0) {
          allReminders.forEach((r: any) => {
            logger.info(
              `🧪 TEST MODE: Reminder ${r._id} - enabled: ${r.enabled}, ` +
              `user_id: ${r.user_id}, test_time: ${r.test_time || 'none'}`
            );
          });
        }
      }

      return result.map((doc: any) => {
        const { users: user, ...reminder } = doc;
        const mappedReminder = {
          ...(reminder as ReminderSetting),
          id: reminder.id || reminder._id?.toString(),
          users: {
            ...(user as User),
            id: user.id || user._id?.toString(),
          },
        };
        
        // Log test_time if present for debugging
        if (mappedReminder.test_time) {
          logger.debug(
            `🧪 TEST MODE: Reminder ${mappedReminder.id} has test_time="${mappedReminder.test_time}"`
          );
        }
        
        return mappedReminder;
      });
    } catch (error) {
      logger.error("Error fetching active reminder settings (Mongo):", error);
      throw error;
    }
  }

  async deleteReminderSetting(reminderId: string): Promise<void> {
    try {
      const reminders = await getReminderPreferencesCollection();
      
      logger.info(`Attempting to delete reminder with ID: ${reminderId} (type: ${typeof reminderId})`);
      
      // Try to delete by _id (ObjectId) or id field
      let filter: any;
      if (ObjectId.isValid(reminderId)) {
        // Try both _id (as ObjectId) and id (as string)
        filter = {
          $or: [
            { _id: new ObjectId(reminderId) },
            { id: reminderId },
          ],
        };
        logger.info(`Using ObjectId filter for deletion: ${JSON.stringify(filter)}`);
      } else {
        filter = { id: reminderId };
        logger.info(`Using string id filter for deletion: ${JSON.stringify(filter)}`);
      }
      
      // First, check if document exists
      const existing = await reminders.findOne(filter);
      if (existing) {
        logger.info(`Found reminder to delete: ${JSON.stringify({ _id: existing._id, id: existing.id })}`);
      } else {
        logger.warn(`No reminder found with filter: ${JSON.stringify(filter)}`);
        // Try alternative: search by _id as ObjectId if valid
        if (ObjectId.isValid(reminderId)) {
          const altFilter = { _id: new ObjectId(reminderId) };
          const altExisting = await reminders.findOne(altFilter);
          if (altExisting) {
            logger.info(`Found reminder with alternative filter, but this shouldn't happen`);
          }
        }
      }
      
      const result = await reminders.deleteOne(filter);
      
      logger.info(`Delete result: ${JSON.stringify({ deletedCount: result.deletedCount, acknowledged: result.acknowledged })}`);
      
      if (result.deletedCount === 0) {
        logger.warn(`No reminder found to delete with ID: ${reminderId}. Filter used: ${JSON.stringify(filter)}`);
        // Try one more time with just _id as ObjectId if it's valid
        if (ObjectId.isValid(reminderId)) {
          const directFilter = { _id: new ObjectId(reminderId) };
          const directResult = await reminders.deleteOne(directFilter);
          logger.info(`Direct _id delete attempt: ${JSON.stringify({ deletedCount: directResult.deletedCount })}`);
          if (directResult.deletedCount === 0) {
            throw new Error(`Failed to delete reminder with ID: ${reminderId}`);
          }
        } else {
          throw new Error(`Failed to delete reminder with ID: ${reminderId}`);
        }
      } else {
        logger.info(`Successfully deleted reminder with ID: ${reminderId}`);
      }
    } catch (error) {
      logger.error("Error deleting reminder setting (Mongo):", error);
      throw error;
    }
  }
}

const mongoService = new MongoService();
export default mongoService;

