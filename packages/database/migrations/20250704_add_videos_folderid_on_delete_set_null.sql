-- Add foreign key constraint to videos.folderId referencing folders.id with ON DELETE SET NULL
ALTER TABLE videos
  ADD CONSTRAINT fk_folder
  FOREIGN KEY (folderId) REFERENCES folders(id)
  ON DELETE SET NULL;
