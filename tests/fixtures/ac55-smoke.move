#[test_only]
module 0xac55259d62fd8c30dd638f46afab109bc6a1066c4e92093b791d60e6bad266e7::decompiler_tests;
use 0xac55259d62fd8c30dd638f46afab109bc6a1066c4e92093b791d60e6bad266e7::{ll, session};
#[test]
fun ladder_and_rounding() {
    assert!(session::ladder_len() == 3, 0);
    assert!(session::ladder_bps(0) == 10000, 1);
    assert!(session::ladder_bps(1) == 5000, 2);
    assert!(session::ladder_bps(2) == 2500, 3);
    assert!(session::principal_for_notional(101, 1) == 50, 4);
    assert!(session::principal_for_notional(101, 2) == 25, 5);
}
#[test]
fun wrapper_roundtrip() {
    let wrapped = ll::wrap(42u64, 7);
    assert!(ll::amount(&wrapped) == 7, 0);
    let (v, a) = ll::unwrap(wrapped);
    assert!(v == 42 && a == 7, 1);
    ll::close(ll::none<u64>());
}
#[test, expected_failure(abort_code = 101, location = session)]
fun invalid_rung() { session::ladder_bps(3); }
#[test, expected_failure(abort_code = 112, location = session)]
fun zero_principal() { session::principal_for_notional(1, 2); }
