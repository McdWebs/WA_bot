import { MongoClient, Db, Collection } from "mongodb";
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
  // User operations
  async getUserByPhone(phoneNumber: string): Promise<User | null> {
    try {
      const users = await getUsersCollection();
      const user = await users.findOne({ phone_number: phoneNumber });
      return user || null;
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
      return {
        ...doc,
        id: result.insertedId.toString(),
      };
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
      return {
        ...user,
        id: user.id || user._id?.toString(),
      };
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
            localField: "user_id",
            foreignField: "id",
            as: "users",
          },
        },
        { $unwind: "$users" },
        { $match: { "users.status": "active" } },
      ];

      const result = await reminders.aggregate(pipeline).toArray();

      return result.map((doc: any) => {
        const { users: user, ...reminder } = doc;
        return {
          ...(reminder as ReminderSetting),
          id: reminder.id || reminder._id?.toString(),
          users: {
            ...(user as User),
            id: user.id || user._id?.toString(),
          },
        };
      });
    } catch (error) {
      logger.error("Error fetching active reminder settings (Mongo):", error);
      throw error;
    }
  }

  async deleteReminderSetting(reminderId: string): Promise<void> {
    try {
      const reminders = await getReminderPreferencesCollection();
      await reminders.deleteOne({ id: reminderId });
    } catch (error) {
      logger.error("Error deleting reminder setting (Mongo):", error);
      throw error;
    }
  }
}

const mongoService = new MongoService();
export default mongoService;

