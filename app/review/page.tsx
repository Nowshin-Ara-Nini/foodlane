import Foodlane from '../foodlane';
import {requirePageRole} from '../auth-session';
export const dynamic='force-dynamic';
export default async function Review(){await requirePageRole('admin','/review');return <Foodlane mode="review"/>}
