import {describe,it,expect} from 'vitest';
import {friendProfileSchema} from '../src/lib/incidents/friend-profile';
describe('Friend declaration validation',()=>{
 it('keeps unspecified capabilities unknown rather than inferred',()=>{expect(Object.values(friendProfileSchema.parse({})).every(v=>v==='')).toBe(true);});
 it('rejects connector state or arbitrary credential fields',()=>{expect(friendProfileSchema.safeParse({connected:true,password:'secret'}).success).toBe(false);});
 it('bounds stored declarations',()=>{expect(friendProfileSchema.safeParse({equipment:'x'.repeat(4001)}).success).toBe(false);});
});
