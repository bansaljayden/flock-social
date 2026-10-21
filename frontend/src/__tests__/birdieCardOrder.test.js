import { venuesByMention } from '../lib/birdieCardOrder';

const v = (name) => ({ name });
const names = (list) => list.map((x) => x.name);

describe('Birdie venue cards follow the reply', () => {
  test('the place the reply names leads, even when the search listed it second', () => {
    const cards = [v('TACODELPHIA'), v('Taqueria La Prima'), v('Blue Corn')];
    expect(names(venuesByMention(cards, 'Taqueria La Prima. Dirt cheap and the al pastor actually hits.')))
      .toEqual(['Taqueria La Prima', 'TACODELPHIA', 'Blue Corn']);
  });

  test('two named places keep the order the reply names them in', () => {
    const cards = [v('Silk City'), v('Pizzeria Stella'), v('Oh Brother Philly')];
    expect(names(venuesByMention(cards, 'Try Oh Brother first, or Silk City if it is packed.')))
      .toEqual(['Oh Brother Philly', 'Silk City', 'Pizzeria Stella']);
  });

  test('a name the reply shortens still counts', () => {
    const cards = [v('Race Street Cafe'), v('The Franklin Fountain')];
    expect(names(venuesByMention(cards, 'Franklin Fountain for dessert.'))).toEqual(['The Franklin Fountain', 'Race Street Cafe']);
  });

  test('accents and punctuation do not stop a match', () => {
    const cards = [v('Cafe Ole'), v('Café Lùcia')];
    expect(names(venuesByMention(cards, 'cafe lucia is the move'))).toEqual(['Café Lùcia', 'Cafe Ole']);
  });

  test('a name only matches as whole words', () => {
    const cards = [v('Bar One'), v('Stella')];
    expect(names(venuesByMention(cards, 'Stellar Pies has room tonight.'))).toEqual(['Bar One', 'Stella']);
  });

  test('nothing named leaves the search order alone', () => {
    const cards = [v('A Place'), v('B Place'), v('C Place')];
    expect(names(venuesByMention(cards, 'Any of these work for five.'))).toEqual(['A Place', 'B Place', 'C Place']);
  });

  test('empty and single lists come back as they are', () => {
    expect(venuesByMention([], 'x')).toEqual([]);
    expect(venuesByMention(undefined, 'x')).toEqual([]);
    const one = [v('Solo')];
    expect(venuesByMention(one, 'Solo')).toBe(one);
  });
});
