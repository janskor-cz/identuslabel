import { combineReducers } from "redux";

import app from "./app";
import enterpriseAgent from "./enterpriseAgent";
import classifiedDocuments from "./classifiedDocuments";

const rootReducer = combineReducers({
    app,
    enterpriseAgent,
    classifiedDocuments,
});

export default rootReducer;
