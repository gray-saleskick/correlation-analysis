import type { Application, LoadSourceType, LoadHistorySourceData } from "@/lib/types";

export interface TabProps {
  app: Application;
  onSave: (a: Application) => void;
}

export interface QuestionsTabProps extends TabProps {
  clientId: string;
  companyDescription: string;
}

export interface UploadTabProps extends TabProps {
  remapState?: { sourceType: LoadSourceType; sourceData: LoadHistorySourceData; entryTimestamp: string } | null;
  onRemapComplete?: () => void;
}

export interface SubmissionsTabProps extends UploadTabProps {
  uploadType: "submissions";
}

export interface WebhooksTabProps extends TabProps {
  clientId: string;
}

export interface CorrelationTabProps extends TabProps {
  clientName: string;
  clientId: string;
}
