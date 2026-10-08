'use client';
/* eslint-disable @next/next/no-img-element -- Catalogue photos use direct media routes. */
import { useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, ChevronLeft, ChevronRight, MapPin, ShieldCheck, Star, ThumbsUp } from 'lucide-react';
import type { Food, DiscoveryCollection } from './foodlane';
import { mostRecommended, mostInterested } from '@/lib/discovery-ranking';

type Shelf = { id: string; title: string; subtitle: string; foods: Food[]; empty: string };
type Props = { foods: Food[]; collection: DiscoveryCollection; onPreview: (food: Food) => void };
const foodPhoto = (food: Food) => food.image?.startsWith('/api/') ? food.image : '/' + (food.image || 'biryani') + '.jpg';

// A shop appears once per shelf, with the lowest-priced dish matching that shelf.
function shopsFor(foods: Food[]) {
  const shops = new Map<string, Food>();
  for (const food of foods) {
    const current = shops.get(food.seller_id);
    if (!current || food.price < current.price) shops.set(food.seller_id, food);
  }
  return [...shops.values()];
}

function ShopCard({ food, onPreview }: { food: Food; onPreview: Props['onPreview'] }) {
  const content = <>
    <div className="shop-tile-image">
      <img src={foodPhoto(food)} alt={food.name} loading="lazy"/>
      <span className="shop-tile-arrow"><ArrowUpRight size={17}/></span>
      {food.demo && <span className="shop-sample-label">Sample shop</span>}
    </div>
    <div className="shop-tile-copy">
      <div className="shop-tile-price">From ৳{food.price}
        {food.original_price && food.original_price > food.price ? <del>৳{food.original_price}</del> : null}
      </div>
      {food.original_price && food.original_price > food.price ?
        <span className="shop-offer">{food.offer_label || 'Save ৳' + (food.original_price - food.price).toFixed(0)}</span> : null}
      <h3>{food.seller_name}{food.status === 'verified' && <ShieldCheck size={14} aria-label="Verified seller"/>}</h3>
      <p>{food.name}</p>
      {food.recommendation_count > 0 && <span className="shop-tile-rating"><ThumbsUp size={12}/>{food.recommendation_count} recommendations</span>}
      <span className="shop-tile-location"><MapPin size={12}/>{food.place_label}</span>
      {food.review_count > 0 && <span className="shop-tile-rating"><Star size={12}/>{Number(food.rating).toFixed(1)} · {food.review_count} reviews</span>}
    </div>
  </>;
  return <article className="shop-tile">
    {food.demo ?
      <button className="shop-tile-link" onClick={() => onPreview(food)} aria-label={'Preview sample shop ' + food.seller_name}>{content}</button> :
      <Link className="shop-tile-link" href={'/sellers/' + encodeURIComponent(food.seller_id)} aria-label={'Visit ' + food.seller_name}>{content}</Link>}
  </article>;
}

function FoodShelf({ shelf, onPreview }: { shelf: Shelf; onPreview: Props['onPreview'] }) {
  const [expanded, setExpanded] = useState(false);
  const rail = useRef<HTMLDivElement>(null);
  return <section className="food-shelf" aria-label={shelf.title}>
    <div className="food-shelf-heading">
      <div><h2>{shelf.title}</h2><p>{shelf.subtitle}</p></div>
      {shelf.foods.length > 1 && <button type="button" className="shelf-view-all" aria-expanded={expanded}
        aria-controls={'shelf-' + shelf.id} onClick={() => setExpanded(value => !value)}>
        {expanded ? 'Show less' : 'View all'}<ArrowUpRight size={15}/>
      </button>}
    </div>
    {shelf.foods.length ? <div className="shelf-rail-wrap">
      <div id={'shelf-' + shelf.id} ref={rail} className={'shop-rail' + (expanded ? ' expanded' : '')}>
        {shelf.foods.map(food => <ShopCard key={food.seller_id} food={food} onPreview={onPreview}/>)}
      </div>
      {!expanded && shelf.foods.length > 3 && <div className="shelf-scroll-buttons">
        <button type="button" aria-label={'Scroll ' + shelf.title + ' left'} onClick={() => rail.current?.scrollBy({ left: -480, behavior: 'smooth' })}><ChevronLeft size={18}/></button>
        <button type="button" aria-label={'Scroll ' + shelf.title + ' right'} onClick={() => rail.current?.scrollBy({ left: 480, behavior: 'smooth' })}><ChevronRight size={18}/></button>
      </div>}
    </div> : <p className="shelf-empty">{shelf.empty}</p>}
  </section>;
}

export default function DiscoveryShelves({ foods, collection, onPreview }: Props) {
  const shops = shopsFor(foods);
  const realShops = shops.filter(food => !food.demo);
  const reviewed = mostRecommended(realShops);
  const interested = mostInterested(realShops);
  const trending = realShops.filter(food => food.interest_count + food.review_count > 0)
    .sort((a, b) => (b.interest_count * 2 + b.review_count) - (a.interest_count * 2 + a.review_count));
  const offers = shopsFor(foods.filter(food => !food.demo && !!food.original_price && food.original_price > food.price));
  const special: Record<Exclude<DiscoveryCollection, 'all'>, Shelf> = {
    reviewed: { id: 'reviewed', title: 'Neighbors love these', subtitle: 'The sellers most recommended by neighbors.', foods: reviewed, empty: 'Recommended shops will appear here as neighbors recommend their favorites.' },
    interested: { id: 'interested', title: 'On everyone’s mind', subtitle: 'Ranked by how many customers are interested.', foods: interested, empty: 'Popular shops will appear here as neighbors show interest.' },
    'burgers-pizza': { id: 'burgers-pizza', title: 'Burgers & pizza', subtitle: 'Find the kitchens and stalls serving your comfort-food favorites.', foods: shopsFor(foods.filter(food => /burger|pizza/i.test(food.category + ' ' + food.name))), empty: 'No burger or pizza shops match these filters.' },
    'trending-sellers': { id: 'trending', title: 'Kitchens on the rise', subtitle: 'Local sellers ranked by interest and reviews.', foods: trending, empty: 'Trending kitchens will appear here as neighbors show interest and leave reviews.' },
    'best-deals': { id: 'best-deals', title: 'Best deals', subtitle: 'Discover lower-priced dishes. Sorted by listed price.', foods: [...shops].sort((a, b) => a.price - b.price), empty: 'No dishes match these filters. Try another cuisine or neighborhood.' },
    offers: { id: 'offers', title: 'Offers', subtitle: 'Special prices from local sellers.', foods: offers, empty: 'No seller offers are listed yet.' },
  };
  const categories = [...new Set(foods.map(food => food.category))].sort((a, b) => a.localeCompare(b));
  const shelves: Shelf[] = collection === 'all' ? [
    { id: 'nearby', title: 'Explore nearby', subtitle: 'Find your next food stop and meet the seller behind it.', foods: shops, empty: 'No shops match these filters.' },
    ...categories.map(category => ({
      id: 'category-' + encodeURIComponent(category), title: category,
      subtitle: 'Meet the shops and stalls serving ' + category.toLocaleLowerCase() + '.',
      foods: shopsFor(foods.filter(food => food.category === category)), empty: 'No shops match these filters.',
    })),
    special['best-deals'],
    ...(reviewed.length ? [special.reviewed] : []),
    ...(interested.length ? [special.interested] : []),
    ...(trending.length ? [special['trending-sellers']] : []),
    special.offers,
  ] : [special[collection]];

  if (collection === 'all' && !foods.length) return <div className="shelf-empty">No food or shops match your search and filters. Try another cuisine or neighborhood.</div>;
  return <div className="discovery-shelves">
    {foods.some(food => food.demo) && <p className="sample-catalogue-note">Sample shops help you explore the layout. Real shops appear here when verified sellers publish food.</p>}
    {shelves.map(shelf => <FoodShelf key={shelf.id} shelf={shelf} onPreview={onPreview}/>)}
  </div>;
}
