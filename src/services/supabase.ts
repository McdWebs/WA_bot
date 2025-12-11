import { createClient } from '@supabase/supabase-js';
import { config } from '../config';
import { User, ReminderSetting } from '../types';
import logger from '../utils/logger';

const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey);

export class SupabaseService {
  // User operations
  async getUserByPhone(phoneNumber: string): Promise<User | null> {
    try {
      const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('phone_number', phoneNumber)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          // No rows returned
          return null;
        }
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Error fetching user by phone:', error);
      throw error;
    }
  }

  async createUser(user: Omit<User, 'id' | 'created_at' | 'updated_at'>): Promise<User> {
    try {
      const { data, error } = await supabase
        .from('users')
        .insert([user])
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error creating user:', error);
      throw error;
    }
  }

  async updateUser(phoneNumber: string, updates: Partial<User>): Promise<User> {
    try {
      const { data, error } = await supabase
        .from('users')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('phone_number', phoneNumber)
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error updating user:', error);
      throw error;
    }
  }

  async getAllActiveUsers(): Promise<User[]> {
    try {
      const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('status', 'active');

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error fetching active users:', error);
      throw error;
    }
  }

  // Reminder settings operations
  async getReminderSettings(userId: string): Promise<ReminderSetting[]> {
    try {
      const { data, error } = await supabase
        .from('reminder_preferences')
        .select('*')
        .eq('user_id', userId);

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error fetching reminder settings:', error);
      throw error;
    }
  }

  async getReminderSetting(
    userId: string,
    reminderType: string
  ): Promise<ReminderSetting | null> {
    try {
      const { data, error } = await supabase
        .from('reminder_preferences')
        .select('*')
        .eq('user_id', userId)
        .eq('reminder_type', reminderType)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          return null;
        }
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Error fetching reminder setting:', error);
      throw error;
    }
  }

  async upsertReminderSetting(setting: Omit<ReminderSetting, 'id' | 'created_at' | 'updated_at'>): Promise<ReminderSetting> {
    try {
      const { data, error } = await supabase
        .from('reminder_preferences')
        .upsert(
          [
            {
              ...setting,
              updated_at: new Date().toISOString(),
            },
          ],
          {
            onConflict: 'user_id,reminder_type',
          }
        )
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error upserting reminder setting:', error);
      throw error;
    }
  }

  async getAllActiveReminderSettings(): Promise<(ReminderSetting & { users: User })[]> {
    try {
      const { data, error } = await supabase
        .from('reminder_preferences')
        .select('*, users!inner(*)')
        .eq('enabled', true)
        .eq('users.status', 'active');

      if (error) throw error;
      return (data || []) as (ReminderSetting & { users: User })[];
    } catch (error) {
      logger.error('Error fetching active reminder settings:', error);
      throw error;
    }
  }

  async deleteReminderSetting(reminderId: string): Promise<void> {
    try {
      const { error } = await supabase
        .from('reminder_preferences')
        .delete()
        .eq('id', reminderId);

      if (error) throw error;
    } catch (error) {
      logger.error('Error deleting reminder setting:', error);
      throw error;
    }
  }
}

export default new SupabaseService();

