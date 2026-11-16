package main

import "testing"

func TestTVName(t *testing.T) {
	good := "Outrageous Fortune/Season 01/Outrageous Fortune - S01E09 - When The Blood Burns [uvGmZSwpzW8]"
	for _, c := range []struct {
		dest, name string
		ok         bool
	}{
		{"", "", true}, {"youtube", "", true}, {"tv", good, true},
		{"tv", "../x/y [uvGmZSwpzW8]", false}, {"tv", "a/b", false}, {"tv", "a/../c [uvGmZSwpzW8]", false},
		{"tv", ".hidden/Season 01/x [uvGmZSwpzW8]", false}, {"tv", "a/Season 01/no id", false}, {"tv", "a/b/c/d [uvGmZSwpzW8]", false},
		{"other", good, false}, {"", good, false}, {"tv", "a/Season: 1/x [uvGmZSwpzW8]", false},
	} {
		if _, ok := tvName(c.dest, c.name); ok != c.ok {
			t.Errorf("tvName(%q, %q) = %v, want %v", c.dest, c.name, ok, c.ok)
		}
	}
}
