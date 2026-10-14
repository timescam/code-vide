const SPECIAL_SPACER_PREFIX = "$";

function predicate_is_spacer_special_char(value:string,_index:number,_array:string[]){
    return value.trim().startsWith(SPECIAL_SPACER_PREFIX);
}

export class TextMatch {
    index : number
    length: number

    constructor(index : number, length: number){
        this.index  = index;
        this.length = length;
    }

    substring_from(text:string){
        return text.slice(this.index,this.index + this.length);
    }
}

interface SpecialSpacerMatcher{
   // A SpecialSpacerMatcher must have a method that receives a character and returns an index delta
   // indicating whether the TextMatcher should stop. Because a special matcher keeps internal
   // state, this method-based approach allows further abstraction.
   poll(char:string): number | null;
   // More than one source can match in the text, so the internal need
   // external reset method to sync
   reset(): void;
}

enum _Text_Case {
    Lower,
    Upper,
    Invalid
} 
class CamelMatcher implements SpecialSpacerMatcher {
    last_last_char: string | null = null;
    last_char: string | null = null;

    get_case(char: string): _Text_Case {
        if (char === " " || char === "\n"){
            return _Text_Case.Invalid;
        }
        return (char.toLowerCase() === char) ? _Text_Case.Lower : _Text_Case.Upper;
    }

    reset(): void {
        this.last_char = null;
        this.last_last_char = null;
    }

    poll(char: string): number | null {
        const prev_prev = this.last_last_char;
        const prev = this.last_char;
        
        this.last_last_char = this.last_char;
        this.last_char = char;
        
        let _should_match : boolean = false;

        if (prev === null) {
            return null;
        }

        if (this.get_case(prev) === _Text_Case.Lower && 
            this.get_case(char) === _Text_Case.Upper){
            _should_match = true;
        }

        if (_should_match === false) {
            if (prev_prev === null){
                return null;
            } else {
                if (this.get_case(String(prev_prev)) === _Text_Case.Upper && 
                    this.get_case(prev) === _Text_Case.Upper &&
                    this.get_case(char) === _Text_Case.Lower
                ){
                    _should_match = true
                }
            }
        } 

        return _should_match ? 0 : null;
    }
}


type SpecialSpacerCtor = new () => SpecialSpacerMatcher;
const AVAILABLE_SPECIAL_SPACERS : Map<string,SpecialSpacerCtor> = new Map(
    [
        ["camel",CamelMatcher],
    ]
)

function is_special_char(char: string): boolean {
    return /[\s\x00-\x1F\x7F]/.test(char);
}

export class TextMatcher{
    text:string
    cursor_idx: number = 0
    word_start_index: number = 0
    last_polled_idx: number = -1;
    chars_spacers : Set<string>
    special_spacers : Set<string>
    special_spacers_matchers : Array<SpecialSpacerMatcher> = []
    
    constructor(text: string,spacers: Array<string>){
        this.text = text;
        this.special_spacers = new Set<string>(
            spacers.filter(predicate_is_spacer_special_char).map(
                (v,i,a) => {
                    return String(v.split(SPECIAL_SPACER_PREFIX).at(-1));
                }
            )
        );
        this.chars_spacers = new Set<string>(
            spacers.filter((v,i,a) => {
                return !predicate_is_spacer_special_char(v,i,a);
            })
        )

        this.special_spacers.forEach(elem => {
            let _matcher_class = AVAILABLE_SPECIAL_SPACERS.get(elem); 
            if (_matcher_class === undefined) {
               throw new Error(`Unknown special spacer: ${elem}`);
            }
            this.special_spacers_matchers.push(
                new _matcher_class()
            )
        });

    }

    next(): TextMatch | null {
        for (; this.cursor_idx < this.text.length; this.cursor_idx += 1) {
            const _cur_char = this.text.at(this.cursor_idx);
            
            if (_cur_char === undefined){
                continue;
            }
 
            const _is_char_spacer = this.chars_spacers.has(_cur_char);
            if (_is_char_spacer || is_special_char(_cur_char)) {
                let _match = new TextMatch(this.word_start_index,(this.cursor_idx - this.word_start_index))
                this.word_start_index = this.cursor_idx + 1;
                this.special_spacers_matchers.forEach(m => m.reset());
                // Adjacent spacers (e.g. ") {") would otherwise produce empty words
                if (_match.length === 0) {
                    continue;
                }
                this.cursor_idx += 1;
                return _match;
            }
            
            if (this.cursor_idx > this.last_polled_idx) {
                this.last_polled_idx = this.cursor_idx;
                for (let index = 0; index < this.special_spacers_matchers.length; index++) {
                    const matcher = this.special_spacers_matchers[index];
                    let _delta_index = matcher.poll(_cur_char);
                    if (_delta_index !== null) {
                        let _match = new TextMatch(this.word_start_index, this.cursor_idx - this.word_start_index);
                        this.cursor_idx += _delta_index;
                        this.word_start_index = this.cursor_idx;
                        return _match;
                    }
                }
            }
        

        }

        if (this.word_start_index != this.cursor_idx){
            let _match = new TextMatch(this.word_start_index,(this.cursor_idx - this.word_start_index))
            this.word_start_index = this.cursor_idx
            return _match;
        }

        return null;
    }
}