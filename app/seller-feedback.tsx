'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, MessageSquare, ThumbsUp } from 'lucide-react';

type Review = { name?: string; rating: number; body: string; created: string; updated: string };
type Props = {
  sellerId: string; foodId?: string; sample?: boolean; role: string; returnTo?: string;
  showRecommendations?: boolean; showReviews?: boolean;
  onChange?: () => void;
};
async function read<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error || 'Could not load customer feedback.');
  return value as T;
}

export default function SellerFeedback({ sellerId, foodId, sample = false, role, returnTo, showRecommendations = true, showReviews = true, onChange }: Props) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reviewCount, setReviewCount] = useState(0);
  const [recommendationCount, setRecommendationCount] = useState(0);
  const [own, setOwn] = useState<Review | null>(null);
  const [recommended, setRecommended] = useState(false);
  const [rating, setRating] = useState(5);
  const [body, setBody] = useState('');
  const [editing, setEditing] = useState(false);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(!sample);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const canSubmit = role === 'buyer' && !sample;
  useEffect(() => {
    if (sample) return;
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      try {
        const [sellerData, foodData, ownReview, personalSeller] = await Promise.all([
          showRecommendations ? read<{seller:{recommendation_count:number}}>(`/api/public/sellers/${encodeURIComponent(sellerId)}`,controller.signal) : Promise.resolve(null),
          foodId && showReviews ? read<{food:{review_count:number;rating:number|null};reviews:Review[]}>(`/api/public/foods/${encodeURIComponent(foodId)}/reviews?page=${page}`,controller.signal) : Promise.resolve(null),
          foodId && role === 'buyer' && showReviews ? read<{review:Review|null}>(`/api/buyer/reviews/${encodeURIComponent(foodId)}`,controller.signal) : Promise.resolve(null),
          role === 'buyer' && showRecommendations ? read<{recommended:boolean}>(`/api/buyer/feedback/${encodeURIComponent(sellerId)}`,controller.signal) : Promise.resolve(null),
        ]);
        if (controller.signal.aborted) return;
        setReviews(foodData?.reviews ?? []);
        setReviewCount(foodData?.food.review_count ?? 0);
        setRecommendationCount(sellerData?.seller.recommendation_count ?? 0);
        setOwn(ownReview?.review ?? null);
        setRecommended(personalSeller?.recommended ?? false);
        setError('');
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load feedback.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [sellerId, foodId, sample, role, page, revision, showRecommendations, showReviews]);

  async function post(path: string, payload: object, success: string) {
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || 'Could not save feedback.');
      setMessage(success);
      setRevision(value => value + 1);
      onChange?.();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Please try again.');
      return false;
    } finally { setBusy(false); }
  }

  return <section className="customer-feedback" aria-label="Customer feedback">
    <div className="feedback-heading"><MessageSquare size={20}/><h2>Customer feedback</h2></div>
    <p className="feedback-intro">{foodId?'Share your experience with this dish. Reviews are separate for every dish.':'Recommendations are about the seller; reviews are about individual dishes.'}</p>
    {error && <div className="status-message" role="alert">{error} <button type="button" className="filter-clear" onClick={() => setRevision(value => value + 1)}>Refresh feedback</button></div>}
    {message && <p className="feedback-message" role="status">{message}</p>}
    {showRecommendations&&<div className="recommendation-row">
      <div><h3>Would you recommend this seller?</h3><p>{sample ? 'Recommendations are available on real sellers.' : recommendationCount + (recommendationCount === 1 ? ' customer recommends this seller' : ' customers recommend this seller')}</p></div>
      <button type="button" className={'button ' + (recommended ? 'liked' : '')} aria-pressed={recommended}
        disabled={!canSubmit || busy || loading} title={recommended ? 'Remove your recommendation' : 'Recommend this seller'}
        onClick={async () => {
          const nextRecommended = !recommended;
          if (await post('/api/buyer/recommendation', { sellerId, recommended: nextRecommended }, recommended ? 'Recommendation removed.' : 'Thanks for recommending this seller.')) setRecommended(nextRecommended);
        }}>{recommended ? <Check size={16}/> : <ThumbsUp size={16}/>} {recommended ? 'Recommended' : 'Recommend'}</button>
    </div>}
    {sample ? <p className="feedback-access-note">This is a sample listing. You can publish reviews and recommendations on real sellers’ dishes and shop pages.</p> :
      !role ? <p className="feedback-access-note"><Link href={'/auth/login?returnTo=' + encodeURIComponent(returnTo || '/sellers/' + sellerId)}>Sign in as a customer</Link> to {foodId?'review this dish':'recommend this seller'}.</p> :
      role !== 'buyer' ? <p className="feedback-access-note">Customer accounts can {foodId?'review dishes':'recommend sellers'}.</p> : null}
    {showReviews&&foodId&&<div className="feedback-review-list">
      <h3>Customer reviews</h3>
      {loading ? <p className="muted">Loading feedback…</p> : !reviews.length ? <p className="muted">No customer reviews yet.</p> :
        reviews.map((review, index) => <article className="review" key={review.created + '-' + index}>
          <div className="feedback-review-meta"><strong>{review.name || 'Customer'}</strong><span>{review.rating} / 5</span></div>
          <p>{review.body}</p><small>{new Date(review.updated || review.created).toLocaleDateString()}</small>
        </article>)}
      {!sample && reviewCount > 20 && <div className="feedback-pages">
        <button type="button" className="button" disabled={page === 1 || loading} onClick={() => setPage(value => value - 1)}>Previous</button>
        <span>Page {page}</span><button type="button" className="button" disabled={page * 20 >= reviewCount || loading} onClick={() => setPage(value => value + 1)}>Next</button>
      </div>}
    </div>}
    {showReviews&&foodId&&own && !editing ? <div className="feedback-own-review"><h3>Your review of this dish</h3><p>{own.rating} / 5 · {own.body}</p>
      <button type="button" className="button" disabled={busy || loading} onClick={() => { setRating(own.rating); setBody(own.body); setEditing(true); }}>Edit your review</button></div> :
      showReviews&&foodId&&<form className="feedback-form" onSubmit={async event => {
        event.preventDefault();
        if (!canSubmit) return;
        if (await post(own ? '/api/buyer/review/edit' : '/api/buyer/review', { foodId, rating, body }, own ? 'Your dish review was updated.' : 'Your dish review was published.')) { setEditing(false); setBody(''); }
      }}>
        <h3>{own ? 'Edit your review' : 'Write your review'}</h3>
        <fieldset disabled={!canSubmit || busy || loading}>
          <legend className="sr-only">Review details</legend>
          <label className="field">Your rating<select value={rating} onChange={event => setRating(Number(event.target.value))}>
            {[5,4,3,2,1].map(value => <option key={value} value={value}>{value} / 5</option>)}
          </select></label>
          <label className="field">Your experience<textarea required maxLength={1000} placeholder="How was the food? What should other neighbors know?" value={body} onChange={event => setBody(event.target.value)}/></label>
          <small>One review per customer per dish. Recommendations are separate and apply once per seller. Your display name appears with your review.</small>
          <button className="button primary">{busy ? 'Saving…' : own ? 'Save review' : 'Publish review'}</button>
        </fieldset>
        {editing && <button type="button" className="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>}
      </form>}
  </section>;
}
