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