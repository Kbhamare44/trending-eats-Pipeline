// Raw data from TikTok oEmbed
export interface TikTokData {
  videoId: string;
  url: string;
  caption: string;
  creatorUsername: string;
  thumbnailUrl: string;
  embedHtml: string;
  likes: number;
  views: number;
}

export interface SubmissionHint {
  restaurantName?: string | null;
  city?: string | null;
  placeId?: string | null;
}

export interface PlaceOption {
  placeId: string;
  name: string;
  address: string;
  city: string;
}

export interface SubmissionResolution {
  restaurantName: string | null;
  nameSource?: { source: string; sourcePhrase: string };
  candidates?: PlaceOption[];
}

// AI classification result
export interface ClassificationResult {
  isRestaurantReview: boolean;
  contentType: 'restaurant_review' | 'recipe' | 'cooking_tutorial' | 'travel_vlog' | 'unrelated';
  confidence: number;
  reasoning: string;
}

// AI extraction result
export interface ExtractionResult {
  restaurantName: string | null;
  restaurantNameEvidence?: { source: 'caption' | 'transcript'; sourcePhrase: string } | null;
  city: string | null;
  cuisine: string | null;
  dishesMentioned: string[];
  sentiment: 'positive' | 'neutral' | 'negative';
  sentimentScore: number;
  pros: string[];
  cons: string[];
  atmosphere: string | null;
  priceRange: string | null;
  goodFor: string[];
  reviewerSummary: string;
  isSponsored: boolean;
  sponsorshipConfidence: number;
  sponsorshipSignals: string[];
}

// Google Places result
export interface PlaceResult {
  placeId: string;
  name: string;
  address: string;
  city: string;
  latitude: number;
  longitude: number;
  phone: string | null;
  website: string | null;
  googleRating: number | null;
  priceLevel: number | null;
  /**
   * How many raters Google reports. Needed by the experience signal: a 4.9
   * from 6 people is much weaker evidence than a 4.4 from 2,000, and treating
   * them alike was making thin ratings look authoritative.
   */
  googleRatingCount?: number | null;
  /** Attribution strings that must be displayed with any Google-sourced field. */
  attribution?: string[];
  /** When these fields were pulled — Places caching terms are time-limited. */
  fetchedAt?: string;
  /**
   * True when another result shares this name. Chains ("Messi Shawarma") have
   * several branches, and taking results[0] picked whichever Google ranked
   * first — a different address from the one in the video.
   */
  ambiguous?: boolean;
  locationVerified?: boolean;
  candidates?: PlaceOption[];
}

// Final processed submission
export interface ProcessedSubmission {
  tiktokData: TikTokData;
  classification: ClassificationResult;
  extraction: ExtractionResult;
  place: PlaceResult;
}

// Pipeline processing status
export type ProcessingStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'rejected';
