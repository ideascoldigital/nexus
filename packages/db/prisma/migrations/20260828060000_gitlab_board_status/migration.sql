-- The board column an issue sat in, kept so an import can place it in the
-- matching kanban column instead of flattening every open issue to backlog.
-- GitLab 18 models board columns as work-item statuses ("Ready for Dev",
-- "Released"), which the REST API does not expose — they come from GraphQL.
ALTER TABLE "GitLabIssue" ADD COLUMN "boardStatus" TEXT;
