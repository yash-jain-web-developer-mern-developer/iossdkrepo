package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"

	"github.com/prebid/openrtb/v20/openrtb2"
)

func strict(data []byte, v interface{}) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	return d.Decode(v)
}

func main() {
	bad := 0
	var reqs []json.RawMessage
	b, _ := os.ReadFile("requests.json")
	json.Unmarshal(b, &reqs)
	for i, r := range reqs {
		var br openrtb2.BidRequest
		if err := strict(r, &br); err != nil {
			fmt.Printf("REQUEST %d does not conform: %v\n", i, err)
			bad++
			continue
		}
		fmt.Printf("request %d ok: imps=%d tmax=%d at=%d video=%v banner=%v\n", i, len(br.Imp), br.TMax, br.AT, br.Imp[0].Video != nil, br.Imp[0].Banner != nil)
	}
	var resps []json.RawMessage
	b, _ = os.ReadFile("responses.json")
	json.Unmarshal(b, &resps)
	for i, r := range resps {
		var br openrtb2.BidResponse
		if err := strict(r, &br); err != nil {
			fmt.Printf("RESPONSE %d does not conform: %v\n", i, err)
			bad++
			continue
		}
		fmt.Printf("response %d ok: seatbids=%d bid price=%v cur=%s\n", i, len(br.SeatBid), br.SeatBid[0].Bid[0].Price, br.Cur)
	}
	// A request built by the library itself, as a real exchange would send it: our bidder must accept it.
	one := int8(1)
	req := openrtb2.BidRequest{ID: "go-1", AT: 2, TMax: 200, Cur: []string{"USD"},
		Imp:    []openrtb2.Imp{{ID: "1", Secure: &one, BidFloor: 0.25, BidFloorCur: "USD", Banner: &openrtb2.Banner{W: ptr(320), H: ptr(50)}}},
		App:    &openrtb2.App{ID: os.Args[1], Name: "Go exchange app", Publisher: &openrtb2.Publisher{ID: "pub1"}},
		Device: &openrtb2.Device{UA: "UA", IP: "203.0.113.9", OS: "Android", Geo: &openrtb2.Geo{Country: "USA"}},
		Regs:   &openrtb2.Regs{COPPA: 0},
	}
	out, _ := json.Marshal(req)
	os.WriteFile("go-request.json", out, 0644)
	if bad > 0 {
		os.Exit(1)
	}
	fmt.Println("ALL CONFORM")
}

func ptr(v int64) *int64 { return &v }
