export interface Disease {
  id: number;
  name: string;
  term: string;
  last_polled_at: string | null;
  created_at: string;
  articleCount?: number;
}

export interface Journal {
  id: number;
  name: string;
  created_at: string;
}

export interface JournalSearchResult {
  title: string;
  abbr: string;
  issn: string;
  metric: number | null; // OpenAlex 2-yr mean citedness
}

export interface JournalSearchResponse {
  results: JournalSearchResult[];
}

export interface Article {
  pmid: string;
  title: string;
  abstract: string;
  journal_name: string;
  authors: string[];
  pub_date: string;
  pub_date_display: string;
  doi: string;
  url: string;
  first_seen_at: string;
}

export interface ArticlesResponse {
  articles: Article[];
  journals: string[];
}

export interface PollResult {
  diseaseId: number;
  diseaseName: string;
  found: number;
  added: number;
  error?: string;
}

export interface RefreshResponse {
  results: PollResult[];
  polledAt: string;
}

export interface AppSettings {
  ncbi_email: string;
  poll_cron: string;
  has_api_key: boolean;
}

export interface GraphNode {
  pmid: string;
  title: string;
  url: string;
  citationCount: number;
  year: number | null; // publication year, null when unknown
}

export interface GraphEdge {
  source: string; // citing paper
  target: string; // cited paper
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
