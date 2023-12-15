CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

CREATE TYPE user_role AS ENUM ('owner', 'admin', 'member');

---------- ### TABLES ### ----------
---------- #################### ----------
---------- #################### ----------
---------- #################### ----------

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name VARCHAR(255),
    email VARCHAR(255) UNIQUE NOT NULL,
    onboarding_questions JSONB,
    avatar_url TEXT,
    video_quota INT NOT NULL DEFAULT 10,
    videos_created INT NOT NULL DEFAULT 0,
    stripe_customer_id VARCHAR(255),
    stripe_subscription_id VARCHAR(255),
    stripe_subscription_status VARCHAR(255),
    stripe_subscription_price_id VARCHAR(255),
    active_space_id UUID REFERENCES spaces(id) ON DELETE SET NULL;
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Spaces table definition
CREATE TABLE spaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Space members table definition (junction table for space to users many-to-many relationship)
CREATE TABLE space_members (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    role user_role NOT NULL,
    PRIMARY KEY (user_id, space_id)
);

-- Videos table definition
CREATE TABLE videos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    s3_url TEXT NOT NULL, -- AWS S3 URL to the video
    thumbnail_url TEXT, -- URL to the video's thumbnail
    duration NUMERIC, -- The length of the video
    metadata JSONB, -- Any additional metadata about the video
    complete BOOLEAN NOT NULL DEFAULT true, -- Whether video is fully processed
    is_public BOOLEAN NOT NULL DEFAULT false, -- Can be shared to spaces
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Shared videos table definition (junction table for video to spaces many-to-many relationship)
CREATE TABLE shared_videos (
    video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
    space_id UUID REFERENCES spaces(id) ON DELETE CASCADE,
    shared_by_user_id UUID REFERENCES users(id) ON DELETE CASCADE, -- Who shared the video
    shared_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (video_id, space_id) -- Ensure a video can't be shared to the same space more than once
);

---------- ### RLS POLICIES ### ----------
---------- #################### ----------
---------- #################### ----------
---------- #################### ----------

---------- ### USERS ### 
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_view_own_data ON users
FOR SELECT USING (id = auth.uid());

CREATE POLICY user_modify_own_data ON users
FOR UPDATE USING (id = auth.uid());

CREATE POLICY user_delete_own_data ON users
FOR DELETE USING (id = auth.uid());

---------- ### SPACES ### 
ALTER TABLE spaces ENABLE ROW LEVEL SECURITY;

CREATE POLICY space_view ON spaces
FOR SELECT USING (
    EXISTS (SELECT 1 FROM space_members WHERE space_members.space_id = spaces.id AND space_members.user_id = auth.uid())
    OR owner_id = auth.uid()
);

CREATE POLICY space_modify ON spaces
FOR UPDATE USING (
    (owner_id = auth.uid()) OR
    (EXISTS (SELECT 1 FROM space_members WHERE space_members.space_id = spaces.id AND space_members.user_id = auth.uid() AND space_members.role = 'admin'))
);

CREATE POLICY space_delete ON spaces
FOR DELETE USING (
    (owner_id = auth.uid()) OR
    (EXISTS (SELECT 1 FROM space_members WHERE space_members.space_id = spaces.id AND space_members.user_id = auth.uid() AND space_members.role = 'admin'))
);

CREATE POLICY space_create ON spaces
FOR INSERT WITH CHECK (
  (owner_id = auth.uid())
);

---------- ### SPACE_MEMBERS ### 

ALTER TABLE space_members ENABLE ROW LEVEL SECURITY;
-- Allow insertion into space members if you are the owner or an admin of that space
CREATE POLICY space_members_insert ON space_members
FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM spaces
    WHERE spaces.id = space_members.space_id
      AND spaces.owner_id = auth.uid()
  ) OR
  EXISTS (
    SELECT 1 FROM space_members adm
    WHERE
      adm.space_id = space_members.space_id
      AND adm.user_id = auth.uid()
      AND adm.role = 'admin'
  )
);

-- Allow deletion of space members if you are the owner or an admin of that space
CREATE POLICY space_members_delete ON space_members
FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM spaces
    WHERE spaces.id = space_members.space_id
      AND spaces.owner_id = auth.uid()
  ) OR
  EXISTS (
    SELECT 1 FROM space_members adm
    WHERE
      adm.space_id = space_members.space_id
      AND adm.user_id = auth.uid()
      AND adm.role = 'admin'
  )
);

---------- ### VIDEOS ###
ALTER TABLE videos ENABLE ROW LEVEL SECURITY;

CREATE POLICY insert_video ON videos
FOR INSERT WITH CHECK (
    auth.uid() = owner_id
);

-- Policy to allow users to view their own videos or view videos shared with spaces they belong to
CREATE POLICY select_video ON videos
FOR SELECT USING (
    auth.uid() = owner_id OR
    EXISTS (
        SELECT 1 
        FROM shared_videos 
        JOIN space_members ON shared_videos.space_id = space_members.space_id
        WHERE shared_videos.video_id = videos.id AND space_members.user_id = auth.uid()
    )
);

-- Policy to allow users to update their own videos
CREATE POLICY update_video ON videos
FOR UPDATE USING (
    auth.uid() = owner_id
);

-- Policy to allow users to delete their own videos and to adjust the remaining quota if needed
CREATE POLICY delete_video ON videos
FOR DELETE USING (
    auth.uid() = owner_id
);

---------- ### SHARED VIDEOS ###
ALTER TABLE shared_videos ENABLE ROW LEVEL SECURITY;

-- Policy to view shared videos within the spaces a user belongs to
CREATE POLICY view_shared_videos ON shared_videos
FOR SELECT USING (
    EXISTS (
        SELECT 1 
        FROM space_members 
        WHERE
            space_members.space_id = shared_videos.space_id AND
            space_members.user_id = auth.uid()
    )
);

-- Policy to share a video with a space
CREATE POLICY share_video ON shared_videos
FOR INSERT WITH CHECK (
    EXISTS (
        SELECT 1 
        FROM videos 
        WHERE videos.id = shared_videos.video_id 
              AND videos.owner_id = auth.uid()
    ) AND
    EXISTS (
        SELECT 1 
        FROM space_members 
        WHERE space_members.space_id = shared_videos.space_id 
              AND space_members.user_id = auth.uid()
    )
);

-- Policy to update shared video records
CREATE POLICY update_shared_videos ON shared_videos
FOR UPDATE USING (
    auth.uid() = shared_videos.shared_by_user_id
);

-- Adding a policy for deletion if it's allowed to unshare videos, 
-- it grants permission to the user who shared the video
CREATE POLICY delete_shared_videos ON shared_videos
FOR DELETE USING (
    auth.uid() = shared_videos.shared_by_user_id
);

---------- ### FUNCTIONS ### ----------
---------- #################### ----------
---------- #################### ----------
---------- #################### ----------

/**
* This trigger automatically creates a user entry when a new user signs up via Supabase Auth.
*/ 
create or replace function public.handle_new_user() 
returns trigger as $$
begin
  insert into public.users (id, email, full_name, avatar_url)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'avatar_url');
  
  return new;
end;
$$ language plpgsql security definer;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Function to increment 'videos_created' counter
CREATE OR REPLACE FUNCTION increment_videos_created()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE users
    SET videos_created = videos_created + 1
    WHERE id = NEW.owner_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to fire the above function after a video is successfully inserted
CREATE TRIGGER increment_videos_created_trigger
AFTER INSERT ON videos
FOR EACH ROW
EXECUTE FUNCTION increment_videos_created();

-- Function to decrement 'videos_created' counter
CREATE OR REPLACE FUNCTION decrement_videos_created()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE users
    SET videos_created = videos_created - 1
    WHERE id = OLD.owner_id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- Trigger to fire the above function before a video is successfully deleted
CREATE TRIGGER decrement_videos_created_trigger
BEFORE DELETE ON videos
FOR EACH ROW
EXECUTE FUNCTION decrement_videos_created();

-- Automatically update the 'updated_at' column when a row is updated
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_videos_timestamp
BEFORE UPDATE ON videos
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER update_spaces_timestamp
BEFORE UPDATE ON spaces
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER update_users_timestamp
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

-- Validate space membership
CREATE OR REPLACE FUNCTION validate_space_membership()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM space_members
        WHERE user_id = NEW.shared_by_user_id AND space_id = NEW.space_id
    )
    THEN
        RAISE EXCEPTION 'User is not a member of the space.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validate_space_membership_trigger
BEFORE INSERT ON shared_videos
FOR EACH ROW
EXECUTE FUNCTION validate_space_membership();

-- Enforce video quota
CREATE OR REPLACE FUNCTION enforce_video_quota()
RETURNS TRIGGER AS $$
BEGIN
    IF (SELECT videos_created FROM users WHERE id = NEW.owner_id) >= (SELECT video_quota FROM users WHERE id = NEW.owner_id) THEN
        RAISE EXCEPTION 'You have reached your video quota.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_video_quota_trigger
BEFORE INSERT ON videos
FOR EACH ROW
EXECUTE FUNCTION enforce_video_quota();

-- Function to set the active space if it's the user's first space or if active_space_id is null
CREATE OR REPLACE FUNCTION set_active_space()
RETURNS TRIGGER AS $$
BEGIN
  IF (SELECT active_space_id FROM users WHERE id = NEW.owner_id) IS NULL THEN
    UPDATE users SET active_space_id = NEW.id WHERE id = NEW.owner_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically set active space when a new space is created
CREATE TRIGGER set_active_space_trigger
AFTER INSERT ON spaces
FOR EACH ROW
EXECUTE FUNCTION set_active_space();

---------- ### INDEXES ### ----------
---------- #################### ----------
---------- #################### ----------
---------- #################### ----------

CREATE INDEX idx_users_active_space ON users(active_space_id);
CREATE INDEX idx_videos_owner ON videos(owner_id);
CREATE INDEX idx_shared_videos_video_id ON shared_videos(video_id);
CREATE INDEX idx_shared_videos_space_id ON shared_videos(space_id);
CREATE INDEX idx_space_members_user_id ON space_members(user_id);
CREATE INDEX idx_space_members_space_id ON space_members(space_id);