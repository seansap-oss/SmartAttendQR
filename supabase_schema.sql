-- ================================================================
-- SmartAttend SaaS - Supabase PostgreSQL Database Schema
-- Run this script in the Supabase SQL Editor (https://supabase.com)
-- ================================================================

-- 1. Employees Table
CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    department TEXT DEFAULT 'General',
    status TEXT DEFAULT 'OUT', -- 'IN' or 'OUT'
    device_token TEXT, -- Unique device UUID bound to this employee
    device_name TEXT, -- e.g. "iPhone 15", "Samsung S23"
    bound_at TIMESTAMPTZ,
    shift_start TEXT DEFAULT '09:00',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Attendance Logs Table (Immutable Audit Trail)
CREATE TABLE IF NOT EXISTS attendance_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
    user_name TEXT NOT NULL,
    event_type TEXT NOT NULL, -- 'CHECK_IN' or 'CHECK_OUT'
    punch_time TIMESTAMPTZ DEFAULT NOW(),
    formatted_time TEXT NOT NULL, -- e.g. "09:02:15 AM"
    date_str TEXT NOT NULL, -- e.g. "2026-08-14"
    method TEXT DEFAULT 'DEVICE_SCAN', -- 'DEVICE_SCAN', 'MANUAL_ADMIN', 'REVERSE_BADGE'
    is_late BOOLEAN DEFAULT FALSE
);

-- 3. Daily Attendance Rollup Summaries (For Fast Payroll & Timesheets)
CREATE TABLE IF NOT EXISTS daily_summaries (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
    date_str TEXT NOT NULL,
    first_clock_in TIMESTAMPTZ,
    last_clock_out TIMESTAMPTZ,
    total_seconds INT DEFAULT 0,
    formatted_duration TEXT DEFAULT '0h 0m 0s',
    status TEXT DEFAULT 'PRESENT',
    UNIQUE(user_id, date_str)
);

-- Create indexes for high performance
CREATE INDEX IF NOT EXISTS idx_logs_user_id ON attendance_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_date ON attendance_logs(date_str);
CREATE INDEX IF NOT EXISTS idx_employees_device ON employees(device_token);
