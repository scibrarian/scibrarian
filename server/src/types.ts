export interface Disease {
  id: number;
  name: string;
  term: string;
  last_polled_at: string | null;
  created_at: string;
}

export interface Journal {
  id: number;
  name: string;
  created_at: string;
}

export interface Article {
  pmid: string;
  title: string;
  abstract: string;
  journal_name: string;
  authors: string[]; // parsed from JSON column
  pub_date: string; // sortable YYYY-MM-DD
  pub_date_display: string; // human-readable, as PubMed reports it
  doi: string;
  url: string;
  first_seen_at: string;
}

export interface PollResult {
  diseaseId: number;
  diseaseName: string;
  found: number; // PMIDs returned by search
  added: number; // new papers inserted
  error?: string;
}

export interface Settings {
  ncbi_api_key: string;
  ncbi_email: string;
  poll_cron: string;
}
