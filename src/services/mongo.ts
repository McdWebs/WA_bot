import dns from "dns";
import { MongoClient, Db, Collection, ObjectId, MongoClientOptions } from "mongodb";
import { config } from "../config";
import { User, ReminderSetting } from "../types";
import logger from "../utils/logger";

// Prefer IPv4 to avoid querySrv ETIMEOUT / secureConnect timeout on some networks
if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("ipv4first");
}

let client: MongoClient | null = null;
let db: Db | null = null;
/** Single in-flight connection promise so concurrent getDb() calls reuse one connect */
let connectPromise: Promise<Db> | null = null;

/** Returns true if the error indicates a lost/stale connection that needs reconnect */
function isConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { name?: string; message?: string; cause?: { code?: string } };
  if (err.name === "MongoServerSelectionError") return true;
  const msg = (err.message ?? "").toLowerCase();
  if (msg.includes("econnreset")) return true;
  if (msg.includes("etimeout") || msg.includes("querySrv") || msg.includes("query_srv")) return true;
  if (msg.includes("timed out") || msg.includes("secureconnect")) return true;
  if (err.cause && typeof err.cause === "object" && (err.cause as { code?: string }).code === "ECONNRESET") return true;
  return false;
}

/** Close the current client and clear cached db so next getDb() reconnects */
async function resetConnection(): Promise<void> {
  if (client) {
    try {
      await client.close();
    } catch (closeErr) {
      logger.warn("Error closing MongoDB client during reset:", closeErr);
    }
    client = null;
    db = null;
    connectPromise = null;
    logger.info("MongoDB connection reset; next operation will reconnect");
  }
}

/**
 * Runs a Mongo operation; on connection error (e.g. ECONNRESET from idle close),
 * resets the connection and retries once. Use around every MongoService method body.
 */
async function withMongoRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isConnectionError(error)) {
      logger.warn("MongoDB connection error, resetting and retrying once", error);
      await resetConnection();
      return await fn();
    }
    throw error;
  }
}

/**
 * Returns the singleton DB instance. Connects once and reuses the same connection
 * for all callers (schedulers, routes, services). Safe to call from many places;
 * only one physical connection is ever created.
 */
export async function getDb(): Promise<Db> {
  if (db) return db;
  if (connectPromise) return connectPromise;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not set in environment variables");
  }

  const options: MongoClientOptions = {
    serverSelectionTimeoutMS: 30000,
    connectTimeoutMS: 20000,
    retryWrites: true,
    retryReads: true,
    maxPoolSize: 10,
    minPoolSize: 1,
    // Refresh connections before Atlas closes idle ones (~30 min); avoids ECONNRESET on Render/low traffic
    maxIdleTimeMS: 25 * 60 * 1000,
  };

  connectPromise = (async (): Promise<Db> => {
    try {
      const newClient = new MongoClient(uri, options);
      await newClient.connect();
      client = newClient;
      const dbNameFromUri = new URL(uri).pathname.replace("/", "") || "wa_bot";
      db = client.db(dbNameFromUri);
      logger.info(`Connected to MongoDB database: ${db.databaseName}`);
      return db;
    } catch (error) {
      connectPromise = null;
      logger.error("Error connecting to MongoDB:", error);
      throw error;
    }
  })();

  return connectPromise;
}

/**
 * Connect to MongoDB once at startup. Call this before starting the server/scheduler.
 * Idempotent: safe to call multiple times; reuses existing connection.
 */
export async function connectMongo(): Promise<Db> {
  return getDb();
}

/**
 * Close the MongoDB connection (e.g. on graceful shutdown).
 * After this, getDb() will reconnect on next use.
 */
export async function closeMongo(): Promise<void> {
  await resetConnection();
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
    return withMongoRetry(async () => {
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
    });
  }

  async createUser(
    user: Omit<User, "id" | "created_at" | "updated_at">
  ): Promise<User> {
    return withMongoRetry(async () => {
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
    });
  }

  async updateUser(
    phoneNumber: string,
    updates: Partial<User>
  ): Promise<User> {
    return withMongoRetry(async () => {
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
    });
  }

  async getAllActiveUsers(): Promise<User[]> {
    return withMongoRetry(async () => {
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
    });
  }

  /**
   * Get all users with optional filters (for dashboard).
   * When hasReminders is true, only returns users that have at least one reminder.
   */
  async getAllUsers(options?: {
    status?: string;
    limit?: number;
    skip?: number;
    search?: string;
    hasReminders?: boolean;
  }): Promise<User[]> {
    return withMongoRetry(async () => {
      try {
        const users = await getUsersCollection();

        if (options?.hasReminders) {
        const matchStage: any = {};
        if (options?.status) matchStage.status = options.status;
        if (options?.search?.trim()) {
          matchStage.phone_number = { $regex: options.search.trim(), $options: "i" };
        }
        const pipeline: any[] = [];
        if (Object.keys(matchStage).length) pipeline.push({ $match: matchStage });
        pipeline.push(
          {
            $lookup: {
              from: "reminder_preferences",
              let: { userOid: "$_id", userId: "$id" },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $or: [
                        { $eq: ["$user_id", "$$userId"] },
                        {
                          $and: [
                            { $ne: ["$$userOid", null] },
                            { $eq: ["$user_id", { $toString: "$$userOid" }] },
                          ],
                        },
                      ],
                    },
                  },
                },
                { $limit: 1 },
              ],
              as: "reminders",
            },
          },
          { $match: { "reminders.0": { $exists: true } } },
          { $sort: { created_at: -1 } }
        );
        if (options?.skip) pipeline.push({ $skip: options.skip });
        if (options?.limit) pipeline.push({ $limit: options.limit });
        pipeline.push({ $project: { reminders: 0 } });
        const result = await users.aggregate(pipeline).toArray();
        return result.map((u: any) => ({
          ...u,
          id: u.id || u._id?.toString(),
        }));
      }

      const filter: any = {};
      if (options?.status) filter.status = options.status;
      if (options?.search?.trim()) {
        filter.phone_number = { $regex: options.search.trim(), $options: "i" };
      }
      const cursor = users.find(filter).sort({ created_at: -1 });
      if (options?.skip) cursor.skip(options.skip);
      if (options?.limit) cursor.limit(options.limit);
      const result = await cursor.toArray();
      return result.map((u: any) => ({
        ...u,
        id: u.id || u._id?.toString(),
      }));
      } catch (error) {
        logger.error("Error fetching all users (Mongo):", error);
        throw error;
      }
    });
  }

  /**
   * Get total user count with optional filters.
   * When hasReminders is true, counts only users that have at least one reminder.
   */
  async getUsersCount(filters?: {
    status?: string;
    search?: string;
    hasReminders?: boolean;
  }): Promise<number> {
    return withMongoRetry(async () => {
      try {
        const users = await getUsersCollection();

        if (filters?.hasReminders) {
        const matchStage: any = {};
        if (filters?.status) matchStage.status = filters.status;
        if (filters?.search?.trim()) {
          matchStage.phone_number = { $regex: filters.search.trim(), $options: "i" };
        }
        const pipeline: any[] = [];
        if (Object.keys(matchStage).length) pipeline.push({ $match: matchStage });
        pipeline.push(
          {
            $lookup: {
              from: "reminder_preferences",
              let: { userOid: "$_id", userId: "$id" },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $or: [
                        { $eq: ["$user_id", "$$userId"] },
                        {
                          $and: [
                            { $ne: ["$$userOid", null] },
                            { $eq: ["$user_id", { $toString: "$$userOid" }] },
                          ],
                        },
                      ],
                    },
                  },
                },
                { $limit: 1 },
              ],
              as: "reminders",
            },
          },
          { $match: { "reminders.0": { $exists: true } } },
          { $count: "total" }
        );
        const result = await users.aggregate(pipeline).toArray();
        return (result[0] as any)?.total ?? 0;
      }

      const filter: any = {};
      if (filters?.status) filter.status = filters.status;
      if (filters?.search?.trim()) {
        filter.phone_number = { $regex: filters.search.trim(), $options: "i" };
      }
      return await users.countDocuments(filter);
      } catch (error) {
        logger.error("Error counting users (Mongo):", error);
        throw error;
      }
    });
  }

  /**
   * Get user by id (_id or id field).
   */
  async getUserById(id: string): Promise<User | null> {
    return withMongoRetry(async () => {
      try {
        const users = await getUsersCollection();
        let filter: any;
        if (ObjectId.isValid(id) && id.length === 24) {
          filter = { $or: [{ _id: new ObjectId(id) }, { id }] };
        } else {
          filter = { id };
        }
        const result = await users.findOne(filter);
        if (!result) return null;
        const u: any = result;
        return { ...u, id: u.id || u._id?.toString() };
      } catch (error) {
        logger.error("Error fetching user by id (Mongo):", error);
        throw error;
      }
    });
  }

  // Reminder settings operations
  async getReminderSettings(userId: string): Promise<ReminderSetting[]> {
    return withMongoRetry(async () => {
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
    });
  }

  async getReminderSetting(
    userId: string,
    reminderType: string
  ): Promise<ReminderSetting | null> {
    return withMongoRetry(async () => {
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
    });
  }

  async upsertReminderSetting(
    setting: Omit<ReminderSetting, "id" | "created_at" | "updated_at">
  ): Promise<ReminderSetting> {
    return withMongoRetry(async () => {
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
    });
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
    return withMongoRetry(async () => {
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
    });
  }

  async getAllActiveReminderSettings(): Promise<
    (ReminderSetting & { users: User })[]
  > {
    return withMongoRetry(async () => {
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
    });
  }

  /**
   * Get all reminder settings with user lookup (for dashboard), with optional filters.
   */
  async getAllReminderSettings(options?: {
    userId?: string;
    enabled?: boolean;
    reminderType?: string;
    limit?: number;
    skip?: number;
  }): Promise<(ReminderSetting & { user?: User })[]> {
    return withMongoRetry(async () => {
      try {
        const reminders = await getReminderPreferencesCollection();
        const match: any = {};
        if (options?.userId) match.user_id = options.userId;
        if (options?.enabled !== undefined) match.enabled = options.enabled;
        if (options?.reminderType) match.reminder_type = options.reminderType;

        const pipeline: any[] = [];
        if (Object.keys(match).length) pipeline.push({ $match: match });
        pipeline.push(
          {
            $lookup: {
              from: "users",
              let: { reminderUserId: "$user_id" },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $or: [
                        { $eq: ["$_id", { $cond: [{ $eq: [{ $type: "$$reminderUserId" }, "string"] }, { $toObjectId: "$$reminderUserId" }, "$$reminderUserId"] }] },
                        { $eq: ["$id", "$$reminderUserId"] },
                      ],
                    },
                  },
                },
              ],
              as: "userDoc",
            },
          },
          { $unwind: { path: "$userDoc", preserveNullAndEmptyArrays: true } },
          { $sort: { created_at: -1 } }
        );
        if (options?.skip) pipeline.push({ $skip: options.skip });
        if (options?.limit) pipeline.push({ $limit: options.limit });

        const result = await reminders.aggregate(pipeline).toArray();
        return result.map((doc: any) => {
          const { userDoc, ...reminder } = doc;
          const user = userDoc
            ? { ...userDoc, id: userDoc.id || userDoc._id?.toString() }
            : undefined;
          return {
            ...reminder,
            id: reminder.id || reminder._id?.toString(),
            user,
          };
        });
      } catch (error) {
        logger.error("Error fetching all reminder settings (Mongo):", error);
        throw error;
      }
    });
  }

  /**
   * Get total reminder count with optional filters.
   */
  async getRemindersCount(filters?: {
    userId?: string;
    enabled?: boolean;
    reminderType?: string;
  }): Promise<number> {
    return withMongoRetry(async () => {
      try {
        const reminders = await getReminderPreferencesCollection();
        const filter: any = {};
        if (filters?.userId) filter.user_id = filters.userId;
        if (filters?.enabled !== undefined) filter.enabled = filters.enabled;
        if (filters?.reminderType) filter.reminder_type = filters.reminderType;
        return await reminders.countDocuments(filter);
      } catch (error) {
        logger.error("Error counting reminders (Mongo):", error);
        throw error;
      }
    });
  }

  /**
   * Get single reminder by id with user (for dashboard).
   */
  async getReminderById(reminderId: string): Promise<(ReminderSetting & { user?: User }) | null> {
    return withMongoRetry(async () => {
      try {
        const reminders = await getReminderPreferencesCollection();
        let filter: any;
        if (ObjectId.isValid(reminderId) && reminderId.length === 24) {
          filter = { $or: [{ _id: new ObjectId(reminderId) }, { id: reminderId }] };
        } else {
          filter = { id: reminderId };
        }
        const doc = await reminders.findOne(filter);
        if (!doc) return null;
        const users = await getUsersCollection();
        const userId = (doc as any).user_id;
        const userFilter =
          typeof userId === "string" && ObjectId.isValid(userId) && userId.length === 24
            ? { _id: new ObjectId(userId) }
            : { $or: [{ _id: new ObjectId(userId) }, { id: userId }] };
        const user = await users.findOne(userFilter);
        const u: any = doc;
        const userMapped = user
          ? { ...user, id: (user as any).id || (user as any)._id?.toString() }
          : undefined;
        return {
          ...u,
          id: u.id || u._id?.toString(),
          user: userMapped,
        };
      } catch (error) {
        logger.error("Error fetching reminder by id (Mongo):", error);
        throw error;
      }
    });
  }

  /**
   * Dashboard stats: users by status, reminders by type, signups over time.
   */
  async getDashboardStats(): Promise<{
    usersByStatus: Record<string, number>;
    usersTotal: number;
    remindersByType: Record<string, number>;
    remindersTotal: number;
    remindersEnabled: number;
    signupsOverTime: { date: string; count: number }[];
  }> {
    return withMongoRetry(async () => {
      try {
        const database = await getDb();
        const users = database.collection<User>("users");
        const reminders = database.collection("reminder_preferences");

        const [byStatus, usersTotal, byType, remindersTotal, remindersEnabled, signups] =
          await Promise.all([
            users.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]).toArray(),
            users.countDocuments(),
            reminders.aggregate([{ $group: { _id: "$reminder_type", count: { $sum: 1 } } }]).toArray(),
            reminders.countDocuments(),
            reminders.countDocuments({ enabled: true }),
            users
              .aggregate([
                {
                  $group: {
                    _id: { $dateToString: { format: "%Y-%m-%d", date: { $toDate: "$created_at" } } },
                    count: { $sum: 1 },
                  },
                },
                { $sort: { _id: 1 } },
                { $limit: 90 },
              ])
              .toArray(),
          ]);

        const usersByStatus: Record<string, number> = {};
        byStatus.forEach((r: any) => {
          usersByStatus[r._id || "unknown"] = r.count;
        });

        const remindersByType: Record<string, number> = {};
        byType.forEach((r: any) => {
          remindersByType[r._id || "unknown"] = r.count;
        });

        const signupsOverTime = (signups as any[]).map((r) => ({
          date: r._id,
          count: r.count,
        }));

        return {
          usersByStatus,
          usersTotal,
          remindersByType,
          remindersTotal,
          remindersEnabled,
          signupsOverTime,
        };
      } catch (error) {
        logger.error("Error fetching dashboard stats (Mongo):", error);
        throw error;
      }
    });
  }

  async deleteReminderSetting(reminderId: string): Promise<void> {
    return withMongoRetry(async () => {
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
    });
  }
}

const mongoService = new MongoService();
export default mongoService;

